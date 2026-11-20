//! A seal made of a random 32-byte wrap key that lives in the operating system's secret store (macOS Keychain, Linux
//! Secret Service) and AES-256-GCM. The store is behind [`SecretStore`] so the logic is tested with a fake.
//!
//! Blob: `"KBK1" || iv(12) || ciphertext || tag(16)`, AAD `kasboek:oseal:wrap:v1` (the `kb_crypto::aead` layout, as the
//! test `FileSeal` uses). The wrap key is created on the first `seal`, only when none exists (never replaced); a lost
//! key means `auth.other_device`, like a copied data folder. A key that is in the store when no native account exists
//! yet (see [`WrapKeySeal::replacing_stale_key`]) was not made for this data and is deleted and made again, not adopted.
use crate::error::OsealError;
use kb_crypto::aead::{seal, unseal, Sealed};
use kb_crypto::encoding::{base64_decode, base64_encode};
use kb_crypto::random_bytes;
use kb_session::oscrypt::SealError;
use kb_session::seal::{OsSeal, SEAL_OS_NATIVE};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Whether the store can be reached at all (asked by `OsSeal::available`, also at start-up). It must not show a
    /// prompt or unlock anything, and a "no" must not be remembered: the store may come up later.
    fn usable(&self) -> bool;
    fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError>;
    /// Stores the wrap key only when there is none: an existing one is never replaced, and `Ok(())` is returned also
    /// when another process created it first (the caller reads the key back with `get`).
    fn create_wrap_key(&self, secret: &[u8]) -> Result<(), OsealError>;
    /// Deletes the wrap key; no key is not an error.
    fn delete_wrap_key(&self) -> Result<(), OsealError>;
}

pub struct WrapKeySeal<S: SecretStore> {
    store: S,
    /// Set until the first `seal` has discarded a wrap key that predates this data.
    replace_stale: AtomicBool,
}

impl<S: SecretStore> WrapKeySeal<S> {
    /// Uses the wrap key that is in the store, or makes one.
    pub fn new(store: S) -> Self {
        Self { store, replace_stale: AtomicBool::new(false) }
    }

    /// For a data folder with no native-sealed account yet: whatever wrap key is in the store was not made for this
    /// data (a leftover, or planted), so the first `seal` deletes it and makes a fresh one instead of adopting it.
    pub fn replacing_stale_key(store: S) -> Self {
        Self { store, replace_stale: AtomicBool::new(true) }
    }

    fn key(&self, item: Option<Zeroizing<Vec<u8>>>) -> Result<Zeroizing<[u8; 32]>, OsealError> {
        let item = item.ok_or(OsealError::NotFound)?;
        let key: [u8; 32] = item.as_slice().try_into().map_err(|_| OsealError::Failed)?;
        Ok(Zeroizing::new(key))
    }

    /// The wrap key; with `create`, a missing one is made. Creating never replaces, and the key is read back: when two
    /// starts race, the store keeps one key and both use that one, not their own random bytes.
    fn wrap_key(&self, create: bool) -> Result<Zeroizing<[u8; 32]>, OsealError> {
        match self.store.get(Item::WrapKey)? {
            Some(found) => self.key(Some(found)),
            None if create => {
                let fresh = Zeroizing::new(random_bytes::<32>());
                self.store.create_wrap_key(&*fresh)?;
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

    fn seal_value(&self) -> &'static str {
        SEAL_OS_NATIVE
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        if self.replace_stale.load(Ordering::Acquire) {
            self.store.delete_wrap_key()?;
            self.replace_stale.store(false, Ordering::Release);
        }
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
        fn create_wrap_key(&self, secret: &[u8]) -> Result<(), OsealError> {
            if self.locked {
                return Err(OsealError::Locked);
            }
            self.items.lock().unwrap().entry("wrap").or_insert_with(|| secret.to_vec());
            Ok(())
        }
        fn delete_wrap_key(&self) -> Result<(), OsealError> {
            if self.locked {
                return Err(OsealError::Locked);
            }
            self.items.lock().unwrap().remove("wrap");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeStore;
    use super::*;
    use kb_session::seal::KeyProtection;
    use std::sync::Arc;

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

    /// A store that has no key at first and lets another "process" create one between our `get` and `create`.
    struct Racing {
        inner: Arc<FakeStore>,
        rival: Vec<u8>,
    }

    impl SecretStore for Racing {
        fn usable(&self) -> bool {
            true
        }
        fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
            self.inner.get(item)
        }
        fn create_wrap_key(&self, secret: &[u8]) -> Result<(), OsealError> {
            // The rival got there first; ours must not replace it.
            self.inner.create_wrap_key(&self.rival)?;
            self.inner.create_wrap_key(secret)
        }
        fn delete_wrap_key(&self) -> Result<(), OsealError> {
            self.inner.delete_wrap_key()
        }
    }

    #[test]
    fn a_racing_creator_keeps_the_first_key_and_both_open_each_others_blobs() {
        let inner = Arc::new(FakeStore::default());
        let ours = WrapKeySeal::new(Racing { inner: inner.clone(), rival: vec![9; 32] });
        let blob = ours.seal(b"invented").unwrap();
        assert_eq!(inner.items.lock().unwrap().get("wrap").unwrap(), &vec![9u8; 32]);
        assert_eq!(ours.unseal(&blob).unwrap().as_slice(), b"invented");
    }

    #[test]
    fn an_existing_key_is_adopted_by_default_but_replaced_when_no_native_account_exists() {
        let adopt = WrapKeySeal::new(FakeStore::default());
        adopt.store.items.lock().unwrap().insert("wrap", vec![4; 32]);
        adopt.seal(b"x").unwrap();
        assert_eq!(adopt.store.items.lock().unwrap().get("wrap").unwrap(), &vec![4u8; 32]);

        let fresh = WrapKeySeal::replacing_stale_key(FakeStore::default());
        fresh.store.items.lock().unwrap().insert("wrap", vec![4; 32]);
        let first = fresh.seal(b"x").unwrap();
        let key = fresh.store.items.lock().unwrap().get("wrap").cloned().unwrap();
        assert_ne!(key, vec![4u8; 32]);
        // Only the first seal discards: the next ones reuse the key they made.
        fresh.seal(b"y").unwrap();
        assert_eq!(fresh.store.items.lock().unwrap().get("wrap").cloned().unwrap(), key);
        assert_eq!(fresh.unseal(&first).unwrap().as_slice(), b"x");
        // No stale key at all is fine too, and a locked store keeps the flag for the next try.
        WrapKeySeal::replacing_stale_key(FakeStore::default()).seal(b"x").unwrap();
        let locked = WrapKeySeal::replacing_stale_key(FakeStore { locked: true, ..FakeStore::default() });
        assert_eq!(locked.seal(b"x").unwrap_err(), SealError::Unavailable);
        assert!(locked.replace_stale.load(Ordering::Acquire));
    }

    #[test]
    fn the_seal_reports_the_native_file_value() {
        assert_eq!(WrapKeySeal::new(FakeStore::default()).seal_value(), "os-native");
    }
}
