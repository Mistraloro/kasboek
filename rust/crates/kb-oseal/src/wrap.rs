//! A seal made of a random 32-byte wrap key that lives in the operating system's secret store (macOS Keychain, Linux
//! Secret Service) and AES-256-GCM. The store is behind [`SecretStore`] so the logic is tested with a fake.
//!
//! Blob: `"KBK1" || iv(12) || ciphertext || tag(16)`, AAD `kasboek:oseal:wrap:v1` (the `kb_crypto::aead` layout, as the
//! test `FileSeal` uses). The wrap key is created on the first `seal`; a lost key means `auth.other_device`, like a
//! copied data folder.
use crate::error::OsealError;
use kb_crypto::aead::{seal, unseal, Sealed};
use kb_crypto::encoding::{base64_decode, base64_encode};
use kb_crypto::random_bytes;
use kb_session::oscrypt::SealError;
use kb_session::seal::OsSeal;
use zeroize::Zeroizing;

pub const WRAP_MAGIC: &[u8; 4] = b"KBK1";
const WRAP_LABEL: &str = "kasboek:oseal:wrap:v1";

/// The two secrets Kasboek keeps in the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    /// Our random 32-byte wrap key.
    WrapKey,
    /// The password Electron's `safeStorage` made ("Kasboek Safe Storage"). Read only.
    ElectronPassword,
}

pub trait SecretStore: Send + Sync {
    /// Whether the store can be reached at all (asked by `OsSeal::available`).
    fn usable(&self) -> bool;
    fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError>;
    /// Only `Item::WrapKey` can be written; the Electron password gives `Unsupported`.
    fn put(&self, item: Item, secret: &[u8]) -> Result<(), OsealError>;
}

pub struct WrapKeySeal<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> WrapKeySeal<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    fn key(&self, item: Option<Zeroizing<Vec<u8>>>) -> Result<Zeroizing<[u8; 32]>, OsealError> {
        let item = item.ok_or(OsealError::NotFound)?;
        let key: [u8; 32] = item.as_slice().try_into().map_err(|_| OsealError::Failed)?;
        Ok(Zeroizing::new(key))
    }

    /// The wrap key; with `create`, a missing one is made and read back (so two racing starts agree on the stored one).
    fn wrap_key(&self, create: bool) -> Result<Zeroizing<[u8; 32]>, OsealError> {
        match self.store.get(Item::WrapKey)? {
            Some(found) => self.key(Some(found)),
            None if create => {
                let fresh = Zeroizing::new(random_bytes::<32>());
                self.store.put(Item::WrapKey, &*fresh)?;
                self.key(self.store.get(Item::WrapKey)?)
            }
            None => Err(OsealError::NotFound),
        }
    }
}

impl<S: SecretStore> OsSeal for WrapKeySeal<S> {
    fn available(&self) -> bool {
        self.store.usable()
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let key = self.wrap_key(true)?;
        let s = seal(&key, plain, WRAP_LABEL);
        let mut out = WRAP_MAGIC.to_vec();
        out.extend(base64_decode(&s.iv).ok_or(SealError::Failed)?);
        out.extend(base64_decode(&s.ct).ok_or(SealError::Failed)?);
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let body = sealed.strip_prefix(WRAP_MAGIC).ok_or(SealError::Unsupported)?;
        if body.len() < 12 + 16 {
            return Err(SealError::Failed);
        }
        let key = self.wrap_key(false).map_err(|e| match e {
            // A lost key cannot open the file: same outcome as a file from another computer.
            OsealError::NotFound => SealError::Failed,
            other => other.into(),
        })?;
        let s = Sealed { iv: base64_encode(&body[..12]), ct: base64_encode(&body[12..]) };
        unseal(&key, &s, WRAP_LABEL).ok_or(SealError::Failed)
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// An in-memory store. `locked` makes every call fail like a locked keychain.
    #[derive(Default)]
    pub struct FakeStore {
        pub items: Mutex<HashMap<&'static str, Vec<u8>>>,
        pub locked: bool,
        pub down: bool,
    }

    fn name(item: Item) -> &'static str {
        match item {
            Item::WrapKey => "wrap",
            Item::ElectronPassword => "electron",
        }
    }

    impl SecretStore for FakeStore {
        fn usable(&self) -> bool {
            !self.down
        }
        fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
            if self.down {
                return Err(OsealError::Unavailable);
            }
            if self.locked {
                return Err(OsealError::Locked);
            }
            Ok(self.items.lock().unwrap().get(name(item)).cloned().map(Zeroizing::new))
        }
        fn put(&self, item: Item, secret: &[u8]) -> Result<(), OsealError> {
            if item == Item::ElectronPassword {
                return Err(OsealError::Unsupported);
            }
            if self.locked {
                return Err(OsealError::Locked);
            }
            self.items.lock().unwrap().insert(name(item), secret.to_vec());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeStore;
    use super::*;
    use kb_session::seal::KeyProtection;

    #[test]
    fn roundtrips_and_creates_the_wrap_key_once() {
        let seal = WrapKeySeal::new(FakeStore::default());
        let blob = seal.seal(b"invented account").unwrap();
        assert_eq!(&blob[..4], WRAP_MAGIC);
        assert_eq!(seal.unseal(&blob).unwrap().as_slice(), b"invented account");
        let key = seal.store.items.lock().unwrap().get("wrap").cloned().unwrap();
        assert_eq!(key.len(), 32);
        // A second seal reuses the key and uses a fresh IV.
        let again = seal.seal(b"invented account").unwrap();
        assert_ne!(blob, again);
        assert_eq!(seal.store.items.lock().unwrap().get("wrap").cloned().unwrap(), key);
        assert_eq!(seal.protection(), KeyProtection::Os);
    }

    #[test]
    fn refuses_foreign_damaged_and_keyless_blobs() {
        let seal = WrapKeySeal::new(FakeStore::default());
        let blob = seal.seal(b"x").unwrap();
        // Another computer: same blob, other wrap key.
        let other = WrapKeySeal::new(FakeStore::default());
        other.seal(b"y").unwrap();
        assert_eq!(other.unseal(&blob).unwrap_err(), SealError::Failed);
        // No key at all: opening never creates one.
        let empty = WrapKeySeal::new(FakeStore::default());
        assert_eq!(empty.unseal(&blob).unwrap_err(), SealError::Failed);
        assert!(empty.store.items.lock().unwrap().is_empty());
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(seal.unseal(&bad).unwrap_err(), SealError::Failed);
        assert_eq!(seal.unseal(&blob[..10]).unwrap_err(), SealError::Failed);
        assert_eq!(seal.unseal(b"v10abcdefghijklmnopqrstuvwxyz0123456789").unwrap_err(), SealError::Unsupported);
    }

    #[test]
    fn a_wrong_sized_wrap_key_is_refused() {
        let seal = WrapKeySeal::new(FakeStore::default());
        seal.store.items.lock().unwrap().insert("wrap", vec![1; 31]);
        assert_eq!(seal.seal(b"x").unwrap_err(), SealError::Failed);
    }

    #[test]
    fn locked_and_missing_stores_are_unavailable() {
        let locked = WrapKeySeal::new(FakeStore { locked: true, ..FakeStore::default() });
        assert!(locked.available());
        assert_eq!(locked.seal(b"x").unwrap_err(), SealError::Unavailable);
        let down = WrapKeySeal::new(FakeStore { down: true, ..FakeStore::default() });
        assert!(!down.available());
        assert_eq!(down.protection(), KeyProtection::Weak);
    }
}
