//! AES-256-GCM with a label as associated data, and HKDF-SHA256. Port of `seal`, `unseal` and `hkdf` in src/core/crypto.ts.
use crate::encoding::{base64_decode, base64_encode};
use crate::{random_bytes, Key};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

/// A sealed value as stored in account files: base64 IV and base64 ciphertext followed by the 16-byte GCM tag.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    pub iv: String,
    pub ct: String,
}

pub(crate) const TAG_LEN: usize = 16;
pub(crate) const IV_LEN: usize = 12;

pub fn seal(key: &[u8; 32], plain: &[u8], label: &str) -> Sealed {
    seal_with_iv(key, plain, label, random_bytes::<IV_LEN>())
}

/// `seal` with a chosen IV. Only for known-answer tests: an IV must never repeat under one key.
pub fn seal_with_iv(key: &[u8; 32], plain: &[u8], label: &str, iv: [u8; IV_LEN]) -> Sealed {
    let ct = Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad: label.as_bytes() })
        .expect("AES-GCM encryption of an in-memory buffer cannot fail");
    Sealed { iv: base64_encode(&iv), ct: base64_encode(&ct) }
}

/// `None` if the key is wrong, the label differs or the data was changed.
///
/// Difference from Node: only 12-byte IVs are supported (the app only writes those).
pub fn unseal(key: &[u8; 32], sealed: &Sealed, label: &str) -> Option<Zeroizing<Vec<u8>>> {
    let iv = base64_decode(&sealed.iv)?;
    let ct = base64_decode(&sealed.ct)?;
    if iv.len() != IV_LEN || ct.len() < TAG_LEN {
        return None;
    }
    let plain = Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: label.as_bytes() }).ok()?;
    Some(Zeroizing::new(plain))
}

/// HKDF-SHA256 to 32 bytes, with `info` as UTF-8.
pub fn hkdf(key: &[u8], salt: &[u8], info: &str) -> Key {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), key).expand(info.as_bytes(), &mut *out).expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_label_binding() {
        let key = [7u8; 32];
        let sealed = seal(&key, b"invented secret", "kasboek:test");
        assert_eq!(unseal(&key, &sealed, "kasboek:test").unwrap().as_slice(), b"invented secret");
        assert!(unseal(&key, &sealed, "kasboek:other").is_none());
        assert!(unseal(&[8u8; 32], &sealed, "kasboek:test").is_none());
    }

    #[test]
    fn unseal_refuses_short_or_foreign_input() {
        let key = [7u8; 32];
        let bad = Sealed { iv: base64_encode(&[0u8; 12]), ct: base64_encode(&[1u8; 5]) };
        assert!(unseal(&key, &bad, "x").is_none());
        let bad_iv = Sealed { iv: base64_encode(&[0u8; 16]), ct: base64_encode(&[1u8; 40]) };
        assert!(unseal(&key, &bad_iv, "x").is_none());
    }

    /// RFC 5869 test case 1.
    #[test]
    fn hkdf_matches_rfc5869_case_1() {
        let ikm = [0x0bu8; 22];
        let salt: Vec<u8> = (0u8..=0x0c).collect();
        // The RFC info is raw bytes f0..f9, which are not UTF-8, so the primitive is called directly.
        let mut okm = [0u8; 42];
        Hkdf::<Sha256>::new(Some(&salt), &ikm).expand(&(0xf0u8..=0xf9).collect::<Vec<_>>(), &mut okm).unwrap();
        assert_eq!(hex::encode(okm), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
        // Our wrapper takes a string info: a plain ASCII case is checked against the same primitive.
        let ours = hkdf(&ikm, &salt, "kasboek:slot");
        let mut direct = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), &ikm).expand(b"kasboek:slot", &mut direct).unwrap();
        assert_eq!(*ours, direct);
    }
}
