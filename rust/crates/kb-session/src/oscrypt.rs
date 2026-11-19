//! Read-only decoder for the values Electron's `safeStorage` writes (Chromium "OSCrypt"), as far as it can be done
//! offline. Spike G6 of docs/rust-port-plan.md. The AES layers are implemented and tested; getting the OS-held key is
//! left to [`OsKeyProvider`] (DPAPI, Keychain, Secret Service / kwallet come with the platform code).
//!
//! # Formats (Chromium `components/os_crypt`, as Electron uses them)
//!
//! | OS | prefix | cipher | key |
//! |---|---|---|---|
//! | Windows | `v10` | AES-256-GCM, layout `v10 || nonce(12) || ciphertext || tag(16)` | 32 bytes. `Local State` (JSON in the data folder) holds `os_crypt.encrypted_key`: base64 of `"DPAPI"` followed by a DPAPI blob (user scope); unprotecting the blob gives the key |
//! | macOS | `v10` | AES-128-CBC, PKCS#7, IV = 16 bytes of `0x20`, layout `v10 || ciphertext` | PBKDF2-HMAC-SHA1(password, salt `saltysalt`, 1003 iterations, 16 bytes). The password is the Keychain item "<app> Safe Storage" (generic password, account "<app>"; for Kasboek `Kasboek Safe Storage`) |
//! | Linux | `v11` | AES-128-CBC, same layout and IV as macOS | PBKDF2-HMAC-SHA1(password, `saltysalt`, 1 iteration, 16 bytes); the password is the secret stored in libsecret (Secret Service) or kwallet under "<app> Safe Storage" |
//! | Linux (no keyring) | `v10` | as `v11` | password is the fixed text `peanuts`. This is the `basic_text` backend: no real protection (`keyProtection` says `weak`) |
//!
//! Not covered: the Windows `v20` (app-bound) prefix, which Chrome uses but Electron does not, and values without a
//! prefix (very old DPAPI blobs). Both give [`SealError::Unsupported`].
//!
//! Open question for G6: Electron 45's *asynchronous* `encryptStringAsync` (what `account-store.ts` calls). It is
//! expected to keep these prefixes and layouts but this could not be verified offline; the first real file from each OS
//! decides. Failures never fall back to guessing: they surface as `auth.other_device`.
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use kb_crypto::encoding::base64_decode;
use sha1::Sha1;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SealError {
    #[error("the operating system seal is not available")]
    Unavailable,
    #[error("the sealed value uses a format that is not supported")]
    Unsupported,
    #[error("the sealed value could not be opened")]
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

/// What only the operating system can give. Implementations come with the platform code; tests use fixed values.
pub trait OsKeyProvider {
    /// Windows: the 32-byte AES key (the DPAPI-unprotected `os_crypt.encrypted_key`, see [`windows_key_from_local_state`]).
    fn windows_key(&self) -> Result<Zeroizing<[u8; 32]>, SealError>;
    /// macOS: the Keychain password of "<app> Safe Storage". Linux: the keyring password (`v11`).
    fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError>;
}

/// Windows DPAPI unprotect in user scope (implemented with the `windows` crate later).
pub trait Dpapi {
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError>;
}

const KEY_PREFIX: &[u8] = b"DPAPI";
const CBC_IV: [u8; 16] = [0x20; 16];
const SALT: &[u8] = b"saltysalt";

/// Reads `os_crypt.encrypted_key` from the text of the `Local State` file and unprotects it.
pub fn windows_key_from_local_state(local_state: &str, dpapi: &dyn Dpapi) -> Result<Zeroizing<[u8; 32]>, SealError> {
    let json: serde_json::Value = serde_json::from_str(local_state).map_err(|_| SealError::Failed)?;
    let encoded = json.pointer("/os_crypt/encrypted_key").and_then(|v| v.as_str()).ok_or(SealError::Failed)?;
    let raw = base64_decode(encoded).ok_or(SealError::Failed)?;
    let blob = raw.strip_prefix(KEY_PREFIX).ok_or(SealError::Unsupported)?;
    let key = dpapi.unprotect(blob)?;
    let key: [u8; 32] = key.as_slice().try_into().map_err(|_| SealError::Failed)?;
    Ok(Zeroizing::new(key))
}

/// `v10 || nonce(12) || ciphertext || tag(16)`.
pub fn decrypt_gcm(key: &[u8; 32], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let body = blob.strip_prefix(b"v10").ok_or(SealError::Unsupported)?;
    if body.len() < 12 + 16 {
        return Err(SealError::Failed);
    }
    let (nonce, ct) = body.split_at(12);
    let plain = Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(nonce), ct).map_err(|_| SealError::Failed)?;
    Ok(Zeroizing::new(plain))
}

/// PBKDF2-HMAC-SHA1 for one output block (the 16 bytes the key needs fit in one 20-byte block).
pub fn pbkdf2_sha1_16(password: &[u8], salt: &[u8], iterations: u32) -> Zeroizing<[u8; 16]> {
    let mac = |data: &[&[u8]]| -> [u8; 20] {
        let mut m = <Hmac<Sha1> as Mac>::new_from_slice(password).expect("HMAC takes keys of any length");
        for d in data {
            m.update(d);
        }
        m.finalize().into_bytes().into()
    };
    let mut u = Zeroizing::new(mac(&[salt, &1u32.to_be_bytes()]));
    let mut t = Zeroizing::new(*u);
    for _ in 1..iterations {
        *u = mac(&[&*u]);
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    let mut out = Zeroizing::new([0u8; 16]);
    out.copy_from_slice(&t[..16]);
    out
}

/// `v10|v11 || ciphertext`, AES-128-CBC with the fixed IV, PKCS#7 padding checked.
pub fn decrypt_cbc(key: &[u8; 16], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let body = blob.strip_prefix(b"v10").or_else(|| blob.strip_prefix(b"v11")).ok_or(SealError::Unsupported)?;
    if body.is_empty() || body.len() % 16 != 0 {
        return Err(SealError::Failed);
    }
    let cipher = Aes128::new(key.into());
    let mut plain = Zeroizing::new(Vec::with_capacity(body.len()));
    let mut prev = CBC_IV;
    for chunk in body.chunks(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        plain.extend(block.iter().zip(prev.iter()).map(|(a, b)| a ^ b));
        // The block holds the decrypted bytes before the IV is applied.
        block.as_mut_slice().zeroize();
        prev.copy_from_slice(chunk);
    }
    let pad = usize::from(*plain.last().ok_or(SealError::Failed)?);
    if pad == 0 || pad > 16 || pad > plain.len() || !plain[plain.len() - pad..].iter().all(|b| usize::from(*b) == pad) {
        return Err(SealError::Failed);
    }
    let keep = plain.len() - pad;
    plain.truncate(keep);
    Ok(plain)
}

/// Opens one `safeStorage` value for the given platform. The key comes from `provider`; `v10` on Linux needs none.
pub fn decode(platform: Platform, blob: &[u8], provider: &dyn OsKeyProvider) -> Result<Zeroizing<Vec<u8>>, SealError> {
    match (platform, blob.get(..3)) {
        (Platform::Windows, Some(b"v10")) => decrypt_gcm(&*provider.windows_key()?, blob),
        (Platform::Macos, Some(b"v10")) => decrypt_cbc(&pbkdf2_sha1_16(&provider.keychain_password()?, SALT, 1003), blob),
        (Platform::Linux, Some(b"v11")) => decrypt_cbc(&pbkdf2_sha1_16(&provider.keychain_password()?, SALT, 1), blob),
        (Platform::Linux, Some(b"v10")) => decrypt_cbc(&pbkdf2_sha1_16(b"peanuts", SALT, 1), blob),
        _ => Err(SealError::Unsupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_sha1_matches_rfc6070() {
        // RFC 6070: P="password", S="salt", c=1 and c=4096, first 16 bytes of the 20-byte output.
        assert_eq!(hex::encode(*pbkdf2_sha1_16(b"password", b"salt", 1)), "0c60c80f961f0e71f3a9b524af601206");
        assert_eq!(hex::encode(*pbkdf2_sha1_16(b"password", b"salt", 4096)), "4b007901b765489abead49d926f721d0");
    }

    #[test]
    fn refuses_unknown_prefixes_and_short_input() {
        struct None_;
        impl OsKeyProvider for None_ {
            fn windows_key(&self) -> Result<Zeroizing<[u8; 32]>, SealError> {
                Err(SealError::Unavailable)
            }
            fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError> {
                Err(SealError::Unavailable)
            }
        }
        assert_eq!(decode(Platform::Windows, b"v20abc", &None_).unwrap_err(), SealError::Unsupported);
        assert_eq!(decode(Platform::Windows, b"", &None_).unwrap_err(), SealError::Unsupported);
        assert_eq!(decode(Platform::Linux, b"v10\x01\x02", &None_).unwrap_err(), SealError::Failed);
        assert_eq!(decode(Platform::Windows, b"v10", &None_).unwrap_err(), SealError::Unavailable);
    }
}
