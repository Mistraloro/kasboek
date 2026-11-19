//! The safeStorage decoder against values made by Node's crypto (rust/parity/fixtures-session/gen-oscrypt.mjs).
use kb_session::oscrypt::{decode, windows_key_from_local_state, Dpapi, OsKeyProvider, Platform, SealError};
use serde_json::Value;
use zeroize::Zeroizing;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../parity/fixtures-session/oscrypt.json")).unwrap()
}

struct Reverse;
impl Dpapi for Reverse {
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        Ok(Zeroizing::new(blob.iter().rev().copied().collect()))
    }
}

struct Provider {
    windows: Option<Zeroizing<[u8; 32]>>,
    password: Option<Vec<u8>>,
}
impl OsKeyProvider for Provider {
    fn windows_key(&self) -> Result<Zeroizing<[u8; 32]>, SealError> {
        self.windows.clone().ok_or(SealError::Unavailable)
    }
    fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError> {
        self.password.clone().map(Zeroizing::new).ok_or(SealError::Unavailable)
    }
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

#[test]
fn windows_v10_gcm_with_the_key_from_local_state() {
    let f = fixtures();
    let key = windows_key_from_local_state(f["windows"]["localState"].as_str().unwrap(), &Reverse).unwrap();
    assert_eq!(hex::encode(*key), f["windows"]["keyHex"].as_str().unwrap());
    let provider = Provider { windows: Some(key), password: None };
    let blob = bytes(&f["windows"]["blobHex"]);
    assert_eq!(decode(Platform::Windows, &blob, &provider).unwrap().as_slice(), f["plain"].as_str().unwrap().as_bytes());
    // A flipped bit and a wrong key are refused, never half-read.
    let mut bad = blob.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(decode(Platform::Windows, &bad, &provider).unwrap_err(), SealError::Failed);
    let other = Provider { windows: Some(Zeroizing::new([1; 32])), password: None };
    assert_eq!(decode(Platform::Windows, &blob, &other).unwrap_err(), SealError::Failed);
}

#[test]
fn local_state_without_the_dpapi_marker_or_key_is_refused() {
    assert_eq!(windows_key_from_local_state("{}", &Reverse).unwrap_err(), SealError::Failed);
    assert_eq!(windows_key_from_local_state(r#"{"os_crypt":{"encrypted_key":"AAAA"}}"#, &Reverse).unwrap_err(), SealError::Unsupported);
    assert_eq!(windows_key_from_local_state("not json", &Reverse).unwrap_err(), SealError::Failed);
}

#[test]
fn macos_v10_cbc_with_the_keychain_password() {
    let f = fixtures();
    let provider = Provider { windows: None, password: Some(f["macos"]["password"].as_str().unwrap().as_bytes().to_vec()) };
    let blob = bytes(&f["macos"]["blobHex"]);
    assert_eq!(decode(Platform::Macos, &blob, &provider).unwrap().as_slice(), f["plain"].as_str().unwrap().as_bytes());
    let wrong = Provider { windows: None, password: Some(b"other".to_vec()) };
    // A wrong key nearly always breaks the padding; either way the plaintext must not come out.
    assert!(decode(Platform::Macos, &blob, &wrong).map(|p| p.as_slice() != f["plain"].as_str().unwrap().as_bytes()).unwrap_or(true));
}

#[test]
fn linux_v11_uses_the_keyring_password_and_v10_uses_peanuts() {
    let f = fixtures();
    let provider = Provider { windows: None, password: Some(f["linuxV11"]["password"].as_str().unwrap().as_bytes().to_vec()) };
    let plain = f["plain"].as_str().unwrap().as_bytes();
    assert_eq!(decode(Platform::Linux, &bytes(&f["linuxV11"]["blobHex"]), &provider).unwrap().as_slice(), plain);
    let none = Provider { windows: None, password: None };
    assert_eq!(decode(Platform::Linux, &bytes(&f["linuxV10"]["blobHex"]), &none).unwrap().as_slice(), plain);
    // The prefix has to belong to the platform.
    assert_eq!(decode(Platform::Macos, &bytes(&f["linuxV11"]["blobHex"]), &provider).unwrap_err(), SealError::Unsupported);
    assert_eq!(decode(Platform::Windows, &bytes(&f["linuxV10"]["blobHex"]), &none).unwrap_err(), SealError::Unavailable);
}

#[test]
fn truncated_cbc_blobs_are_refused() {
    let f = fixtures();
    let none = Provider { windows: None, password: None };
    let blob = bytes(&f["linuxV10"]["blobHex"]);
    for cut in [3, 4, blob.len() - 1, blob.len() - 16] {
        assert!(decode(Platform::Linux, &blob[..cut], &none).is_err(), "cut at {cut}");
    }
}
