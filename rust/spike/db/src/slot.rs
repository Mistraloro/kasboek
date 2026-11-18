//! Port of the password slot from src/core/crypto.ts (Argon2id + AES-256-GCM with a label as AAD).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Sealed {
    pub iv: String,
    pub ct: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Kdf {
    pub name: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Slot {
    pub kdf: Kdf,
    pub sealed: Sealed,
}

pub const PASSWORD_LABEL: &str = "kasboek:slot:password";

pub fn derive_key(password: &str, kdf: &Kdf) -> Result<[u8; 32], String> {
    if kdf.name != "argon2id" {
        return Err("only argon2id in this spike".into());
    }
    // Same caps as deriveSlotKey.
    if kdf.m > 1024 * 1024 || kdf.t > 10 || kdf.p > 16 || kdf.m < 8 * kdf.p {
        return Err("crypto.unsupported".into());
    }
    let salt = B64.decode(&kdf.salt).map_err(|e| e.to_string())?;
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| e.to_string())?;
    let pw: String = password.nfkc().collect();
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pw.as_bytes(), &salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn seal(key: &[u8; 32], plain: &[u8], iv: [u8; 12], label: &str) -> Sealed {
    let c = Aes256Gcm::new(key.into());
    let ct = c.encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad: label.as_bytes() }).expect("seal");
    Sealed { iv: B64.encode(iv), ct: B64.encode(ct) }
}

/// None if the key is wrong or the data was changed.
pub fn unseal(key: &[u8; 32], s: &Sealed, label: &str) -> Option<Vec<u8>> {
    let iv = B64.decode(&s.iv).ok()?;
    let ct = B64.decode(&s.ct).ok()?;
    if iv.len() != 12 {
        return None;
    }
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: label.as_bytes() }).ok()
}

pub fn open_slot(slot: &Slot, password: &str) -> Option<Vec<u8>> {
    unseal(&derive_key(password, &slot.kdf).ok()?, &slot.sealed, PASSWORD_LABEL)
}

/// `salt` and `iv` are passed in so the spike needs no RNG crate.
pub fn make_slot(master: &[u8], password: &str, m: u32, t: u32, p: u32, salt: [u8; 16], iv: [u8; 12]) -> Slot {
    let kdf = Kdf { name: "argon2id".into(), m, t, p, salt: B64.encode(salt) };
    let key = derive_key(password, &kdf).expect("kdf");
    Slot { sealed: seal(&key, master, iv, PASSWORD_LABEL), kdf }
}
