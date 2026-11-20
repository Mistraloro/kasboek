//! Linux Secret Service (GNOME Keyring, KeePassXC, ...) through the pure-Rust `oo7` crate, blocking.
//!
//! - Ours: attributes `service=Kasboek`, `account=wrap-key`, label `Kasboek wrap key`, 32 raw bytes.
//! - Electron/Chromium's: the item labelled `Kasboek Safe Storage` (attribute `application=Kasboek`), read only. KWallet
//!   is not supported (`Unavailable`, so a `v11` value from a KWallet user cannot be opened).
//!
//! Only the default collection is used and never created here. A locked collection is unlocked, which may show the
//! desktop's prompt. Call from a worker thread, not from inside an async executor (it blocks).
use crate::error::OsealError;
use crate::wrap::{Item, SecretStore};
use futures_lite::future::block_on;
use oo7::dbus::{Collection, Error as OError, Service};
use oo7::Secret;
use std::sync::OnceLock;
use zeroize::Zeroizing;

const WRAP_ATTRS: [(&str, &str); 2] = [("service", "Kasboek"), ("account", "wrap-key")];
const ELECTRON_ATTRS: [(&str, &str); 1] = [("application", "Kasboek")];
const ELECTRON_LABEL: &str = "Kasboek Safe Storage";
const WRAP_LABEL: &str = "Kasboek wrap key";

#[derive(Default)]
pub struct SecretService {
    usable: OnceLock<bool>,
}

impl SecretService {
    pub fn new() -> Self {
        Self::default()
    }
}

fn map(e: OError) -> OsealError {
    match e {
        OError::Dismissed => OsealError::Locked,
        OError::ZBus(_) => OsealError::Unavailable,
        OError::NotFound(_) | OError::Deleted => OsealError::NotFound,
        _ => OsealError::Failed,
    }
}

async fn collection() -> Result<Collection, OsealError> {
    let service = Service::new().await.map_err(map)?;
    let collection = service.with_alias(Service::DEFAULT_COLLECTION).await.map_err(map)?.ok_or(OsealError::Unavailable)?;
    if collection.is_locked().await.map_err(map)? {
        collection.unlock(None).await.map_err(map)?;
    }
    Ok(collection)
}

async fn get(item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
    let collection = collection().await?;
    let found = match item {
        Item::WrapKey => collection.search_items(&WRAP_ATTRS).await,
        Item::ElectronPassword => collection.search_items(&ELECTRON_ATTRS).await,
    }
    .map_err(map)?;
    let mut chosen = None;
    for candidate in found {
        // Prefer the item with Chromium's label when several share the attribute.
        let labelled = item == Item::WrapKey || candidate.label().await.map_err(map)? == ELECTRON_LABEL;
        if chosen.is_none() || labelled {
            chosen = Some(candidate);
        }
        if labelled {
            break;
        }
    }
    match chosen {
        Some(item) => {
            let secret: Secret = item.secret().await.map_err(map)?;
            Ok(Some(Zeroizing::new(secret.as_bytes().to_vec())))
        }
        None => Ok(None),
    }
}

async fn put(secret: &[u8]) -> Result<(), OsealError> {
    let collection = collection().await?;
    collection.create_item(WRAP_LABEL, &WRAP_ATTRS, Secret::blob(secret), true, None).await.map_err(map)?;
    Ok(())
}

async fn remove() -> Result<(), OsealError> {
    let collection = collection().await?;
    for item in collection.search_items(&WRAP_ATTRS).await.map_err(map)? {
        item.delete(None).await.map_err(map)?;
    }
    Ok(())
}

impl SecretService {
    /// Removes the wrap key. Everything sealed with it can no longer be opened.
    pub fn remove_wrap_key(&self) -> Result<(), OsealError> {
        block_on(remove())
    }
}

impl SecretStore for SecretService {
    fn usable(&self) -> bool {
        *self.usable.get_or_init(|| block_on(collection()).is_ok())
    }

    fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
        block_on(get(item))
    }

    fn put(&self, item: Item, secret: &[u8]) -> Result<(), OsealError> {
        match item {
            Item::WrapKey => block_on(put(secret)),
            Item::ElectronPassword => Err(OsealError::Unsupported),
        }
    }
}
