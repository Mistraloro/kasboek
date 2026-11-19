//! Key slots: the master key wrapped by a key derived from one credential. Port of the slot part of src/core/crypto.ts.
//!
//! Password slots use Argon2id (legacy ones scrypt, opened and then re-made by the caller). The recovery key is a
//! high-entropy secret, so its slot uses HKDF-SHA256 with the info string `kasboek:slot`.
use crate::aead::{hkdf, seal, seal_with_iv, unseal, Sealed};
use crate::encoding::base64_decode;
use crate::error::CryptoError;
use crate::{random_bytes, Key, Master};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

/// The KDF of a slot, as written in the file. Field order is the order the TypeScript core writes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "name")]
pub enum Kdf {
    #[serde(rename = "argon2id")]
    Argon2id { m: u64, t: u64, p: u64, salt: String },
    #[serde(rename = "scrypt")]
    Scrypt {
        #[serde(rename = "N")]
        n: u64,
        r: u64,
        p: u64,
        salt: String,
    },
    #[serde(rename = "hkdf")]
    Hkdf { salt: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub kdf: Kdf,
    pub sealed: Sealed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Password,
    Recovery,
}

impl SlotKind {
    /// The associated data of the sealed master key.
    pub fn label(self) -> &'static str {
        match self {
            Self::Password => "kasboek:slot:password",
            Self::Recovery => "kasboek:slot:recovery",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Cost {
    /// Memory in KiB.
    pub m: u64,
    pub t: u64,
    pub p: u64,
}

/// 128 MiB, 3 passes, 4 lanes (`PASSWORD_KDF` in crypto.ts).
pub const PASSWORD_KDF: Argon2Cost = Argon2Cost { m: 128 * 1024, t: 3, p: 4 };

const HKDF_SLOT_INFO: &str = "kasboek:slot";
/// Node's `maxmem` for scrypt in deriveSlotKey.
const SCRYPT_MAXMEM: u128 = 256 * 1024 * 1024;

fn salt_bytes(salt: &str) -> Result<Vec<u8>, CryptoError> {
    base64_decode(salt).ok_or_else(|| CryptoError::Kdf("the salt is not base64".into()))
}

/// The key that wraps the master key. Costs are capped so a crafted file can't make the app hang or run out of memory.
pub fn derive_slot_key(secret: &str, kdf: &Kdf) -> Result<Key, CryptoError> {
    let mut out = Zeroizing::new([0u8; 32]);
    match kdf {
        Kdf::Hkdf { salt } => return Ok(hkdf(secret.as_bytes(), &salt_bytes(salt)?, HKDF_SLOT_INFO)),
        Kdf::Argon2id { m, t, p, salt } => {
            if *m > 1024 * 1024 || *t > 10 || *p > 16 || *m < 8 * *p {
                return Err(CryptoError::Unsupported);
            }
            let params = Params::new(*m as u32, *t as u32, *p as u32, Some(32)).map_err(|e| CryptoError::Kdf(e.to_string()))?;
            let password = Zeroizing::new(secret.nfkc().collect::<String>());
            Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
                .hash_password_into(password.as_bytes(), &salt_bytes(salt)?, &mut *out)
                .map_err(|e| CryptoError::Kdf(e.to_string()))?;
        }
        Kdf::Scrypt { n, r, p, salt } => {
            if *n > 1 << 20 || *r > 16 || *p > 4 {
                return Err(CryptoError::Unsupported);
            }
            // Node refuses to run scrypt above `maxmem`: 128*r*p for the blocks plus 128*r*(N+2) for the table.
            let memory = u128::from(*p) * 128 * u128::from(*r) + 128 * u128::from(*r) * (u128::from(*n) + 2);
            if !n.is_power_of_two() || *n < 2 || memory > SCRYPT_MAXMEM {
                return Err(CryptoError::Kdf("invalid scrypt parameters".into()));
            }
            let params =
                scrypt::Params::new(n.trailing_zeros() as u8, *r as u32, *p as u32, 32).map_err(|e| CryptoError::Kdf(e.to_string()))?;
            let password = Zeroizing::new(secret.nfkc().collect::<String>());
            scrypt::scrypt(password.as_bytes(), &salt_bytes(salt)?, &params, &mut *out).map_err(|e| CryptoError::Kdf(e.to_string()))?;
        }
    }
    Ok(out)
}

/// Wraps the master key with a password (Argon2id, `cost`) or a high-entropy secret such as the recovery key (HKDF).
pub fn make_slot_with(master: &[u8; 32], secret: &str, kind: SlotKind, cost: Argon2Cost) -> Result<Slot, CryptoError> {
    let salt = crate::encoding::base64_encode(&random_bytes::<16>());
    let kdf = match kind {
        SlotKind::Password => Kdf::Argon2id { m: cost.m, t: cost.t, p: cost.p, salt },
        SlotKind::Recovery => Kdf::Hkdf { salt },
    };
    let key = derive_slot_key(secret, &kdf)?;
    Ok(Slot { sealed: seal(&key, master, kind.label()), kdf })
}

pub fn make_slot(master: &[u8; 32], secret: &str, kind: SlotKind) -> Result<Slot, CryptoError> {
    make_slot_with(master, secret, kind, PASSWORD_KDF)
}

/// `make_slot_with` with chosen salt and IV, for known-answer tests only.
pub fn make_slot_fixed(
    master: &[u8; 32],
    secret: &str,
    kind: SlotKind,
    cost: Argon2Cost,
    salt: [u8; 16],
    iv: [u8; 12],
) -> Result<Slot, CryptoError> {
    let salt = crate::encoding::base64_encode(&salt);
    let kdf = match kind {
        SlotKind::Password => Kdf::Argon2id { m: cost.m, t: cost.t, p: cost.p, salt },
        SlotKind::Recovery => Kdf::Hkdf { salt },
    };
    let key = derive_slot_key(secret, &kdf)?;
    Ok(Slot { sealed: seal_with_iv(&key, master, kind.label(), iv), kdf })
}

/// True for slots made with an older, weaker setting; they are re-made after the next unlock.
pub fn slot_needs_upgrade(slot: &Slot) -> bool {
    matches!(slot.kdf, Kdf::Scrypt { .. })
}

/// `Ok(None)` if the secret is wrong. `Err` if the slot's KDF settings are refused or the master key has a wrong size.
pub fn open_slot(slot: &Slot, secret: &str, kind: SlotKind) -> Result<Option<Master>, CryptoError> {
    let key = derive_slot_key(secret, &slot.kdf)?;
    let Some(plain) = unseal(&key, &slot.sealed, kind.label()) else {
        return Ok(None);
    };
    let master: [u8; 32] = plain.as_slice().try_into().map_err(|_| CryptoError::Corrupt)?;
    Ok(Some(Zeroizing::new(master)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHEAP: Argon2Cost = Argon2Cost { m: 64, t: 1, p: 1 };

    #[test]
    fn password_slot_roundtrip_with_nfkc() {
        let master = [3u8; 32];
        let slot = make_slot_with(&master, "pässﬁ Zoë ①", SlotKind::Password, CHEAP).unwrap();
        // The ligature and the circled digit normalise to "fi" and "1".
        let opened = open_slot(&slot, "pässfi Zoë 1", SlotKind::Password).unwrap().unwrap();
        assert_eq!(*opened, master);
        assert!(open_slot(&slot, "other", SlotKind::Password).unwrap().is_none());
        assert!(open_slot(&slot, "pässfi Zoë 1", SlotKind::Recovery).unwrap().is_none(), "label is bound");
    }

    #[test]
    fn recovery_slot_uses_hkdf() {
        let slot = make_slot(&[4u8; 32], "ABCD-EFGH", SlotKind::Recovery).unwrap();
        assert!(matches!(slot.kdf, Kdf::Hkdf { .. }));
        assert!(open_slot(&slot, "ABCD-EFGH", SlotKind::Recovery).unwrap().is_some());
    }

    #[test]
    fn costs_above_the_caps_are_refused() {
        let salt = "AAECAwQFBgcICQoLDA0ODw==".to_string();
        for kdf in [
            Kdf::Argon2id { m: 1024 * 1024 + 1, t: 1, p: 1, salt: salt.clone() },
            Kdf::Argon2id { m: 64, t: 11, p: 1, salt: salt.clone() },
            Kdf::Argon2id { m: 1024, t: 1, p: 17, salt: salt.clone() },
            Kdf::Argon2id { m: 7, t: 1, p: 1, salt: salt.clone() },
            Kdf::Scrypt { n: 1 << 21, r: 8, p: 1, salt: salt.clone() },
            Kdf::Scrypt { n: 1024, r: 17, p: 1, salt: salt.clone() },
            Kdf::Scrypt { n: 1024, r: 8, p: 5, salt },
        ] {
            assert_eq!(derive_slot_key("x", &kdf).unwrap_err(), CryptoError::Unsupported, "{kdf:?}");
        }
    }

    #[test]
    fn scrypt_slot_opens_and_is_flagged_for_upgrade() {
        let kdf = Kdf::Scrypt { n: 1024, r: 8, p: 1, salt: "AAECAwQFBgcICQoLDA0ODw==".into() };
        let key = derive_slot_key("pässword", &kdf).unwrap();
        let slot = Slot { sealed: seal(&key, &[9u8; 32], SlotKind::Password.label()), kdf };
        assert!(slot_needs_upgrade(&slot));
        assert_eq!(*open_slot(&slot, "pässword", SlotKind::Password).unwrap().unwrap(), [9u8; 32]);
    }

    #[test]
    fn slot_json_uses_the_field_order_of_the_app() {
        let slot = make_slot_fixed(&[1u8; 32], "x", SlotKind::Password, CHEAP, [0; 16], [0; 12]).unwrap();
        let json = serde_json::to_string(&slot).unwrap();
        assert!(json.starts_with(r#"{"kdf":{"name":"argon2id","m":64,"t":1,"p":1,"salt":""#), "{json}");
        let scrypt = Kdf::Scrypt { n: 1024, r: 8, p: 1, salt: "AA==".into() };
        assert_eq!(serde_json::to_string(&scrypt).unwrap(), r#"{"name":"scrypt","N":1024,"r":8,"p":1,"salt":"AA=="}"#);
    }
}
