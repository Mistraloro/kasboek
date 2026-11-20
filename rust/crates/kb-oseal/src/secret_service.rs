//! Linux Secret Service (GNOME Keyring, KeePassXC, ...) through the pure-Rust `oo7` crate, blocking.
//!
//! - Ours: attributes `service=Kasboek`, `account=wrap-key`, label `Kasboek wrap key`, 32 raw bytes. Created only when
//!   absent, never replaced.
//! - Electron/Chromium's: the item labelled `Kasboek Safe Storage` (attribute `application=Kasboek`), read only. KWallet
//!   is not supported (`Unavailable`, so a `v11` value from a KWallet user cannot be opened).
//!
//! Only the default collection is used and never created here. `usable()` does not unlock it; reading or creating a
//! secret does, which may show the desktop's prompt. Call from a worker thread, not from inside an async executor (it
//! blocks).
use crate::error::OsealError;
use crate::wrap::{Item, SecretStore};
use futures_lite::future::block_on;
use oo7::dbus::{Collection, Error as OError, Item as OItem, Service};
use oo7::Secret;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use zeroize::Zeroizing;

const WRAP_SERVICE: &str = "Kasboek";
const WRAP_ACCOUNT: &str = "wrap-key";
const ELECTRON_ATTRS: [(&str, &str); 1] = [("application", "Kasboek")];
const ELECTRON_LABEL: &str = "Kasboek Safe Storage";
const WRAP_LABEL: &str = "Kasboek wrap key";

/// Serialises creation inside this process; another process is handled by [`create_wrap_key`]'s check afterwards.
static CREATE: Mutex<()> = Mutex::new(());

pub struct SecretService {
    wrap_attrs: [(String, String); 2],
    /// Set once the service has answered; a failure is asked again (the keyring may start after the desktop session).
    reachable: AtomicBool,
}

impl Default for SecretService {
    fn default() -> Self {
        Self::with_wrap_account(WRAP_ACCOUNT)
    }
}

impl SecretService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keeps the wrap key under another `account` attribute (tests use their own, never the real item).
    pub fn with_wrap_account(account: &str) -> Self {
        Self {
            wrap_attrs: [("service".to_owned(), WRAP_SERVICE.to_owned()), ("account".to_owned(), account.to_owned())],
            reachable: AtomicBool::new(false),
        }
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

/// The default collection as it is: no unlock, so no desktop prompt.
async fn locked_or_not() -> Result<Collection, OsealError> {
    let service = Service::new().await.map_err(map)?;
    service.with_alias(Service::DEFAULT_COLLECTION).await.map_err(map)?.ok_or(OsealError::Unavailable)
}

/// The default collection, unlocked. This may show the desktop's prompt: only call it when a secret is needed.
async fn collection() -> Result<Collection, OsealError> {
    let collection = locked_or_not().await?;
    if collection.is_locked().await.map_err(map)? {
        collection.unlock(None).await.map_err(map)?;
    }
    Ok(collection)
}

/// The oldest of several items with the same attributes (ties: lowest object path). Everybody picks the same one, so
/// two processes that raced to create the wrap key end up using one key.
async fn oldest(items: Vec<OItem>) -> Result<Option<OItem>, OsealError> {
    let mut best: Option<(std::time::Duration, String, OItem)> = None;
    for item in items {
        let key = (item.created().await.map_err(map)?, item.path().to_string());
        if best.as_ref().is_none_or(|(c, p, _)| key < (*c, p.clone())) {
            best = Some((key.0, key.1, item));
        }
    }
    Ok(best.map(|(_, _, item)| item))
}

async fn secret_of(item: &OItem) -> Result<Zeroizing<Vec<u8>>, OsealError> {
    let secret: Secret = item.secret().await.map_err(map)?;
    Ok(Zeroizing::new(secret.as_bytes().to_vec()))
}

async fn get(attrs: &[(String, String); 2], item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
    let collection = collection().await?;
    match item {
        Item::WrapKey => match oldest(collection.search_items(attrs).await.map_err(map)?).await? {
            Some(found) => Ok(Some(secret_of(&found).await?)),
            None => Ok(None),
        },
        Item::ElectronPassword => {
            let found = collection.search_items(&ELECTRON_ATTRS).await.map_err(map)?;
            let mut chosen = None;
            for candidate in found {
                // Prefer the item with Chromium's label when several share the attribute.
                let labelled = candidate.label().await.map_err(map)? == ELECTRON_LABEL;
                if chosen.is_none() || labelled {
                    chosen = Some(candidate);
                }
                if labelled {
                    break;
                }
            }
            match chosen {
                Some(found) => Ok(Some(secret_of(&found).await?)),
                None => Ok(None),
            }
        }
    }
}

/// Never replaces: the Secret Service would make a second item for `replace=false`, so after creating, the oldest item
/// is the winner and a loser deletes only its own.
async fn create_wrap_key(attrs: &[(String, String); 2], secret: &[u8]) -> Result<(), OsealError> {
    let collection = collection().await?;
    if !collection.search_items(attrs).await.map_err(map)?.is_empty() {
        return Ok(());
    }
    let mine = collection.create_item(WRAP_LABEL, attrs, Secret::blob(secret), false, None).await.map_err(map)?;
    let all = collection.search_items(attrs).await.map_err(map)?;
    if all.len() > 1 {
        let won = oldest(all).await?.is_some_and(|w| w.path() == mine.path());
        if !won {
            mine.delete(None).await.map_err(map)?;
        }
    }
    Ok(())
}

async fn remove(attrs: &[(String, String); 2]) -> Result<(), OsealError> {
    let collection = collection().await?;
    for item in collection.search_items(attrs).await.map_err(map)? {
        item.delete(None).await.map_err(map)?;
    }
    Ok(())
}

impl SecretStore for SecretService {
    /// Whether the service answers and has a default collection. A locked collection counts as usable: unlocking
    /// (which may prompt) waits until a secret is needed.
    fn usable(&self) -> bool {
        if self.reachable.load(Ordering::Relaxed) {
            return true;
        }
        let yes = block_on(locked_or_not()).is_ok();
        self.reachable.store(yes, Ordering::Relaxed);
        yes
    }

    fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
        block_on(get(&self.wrap_attrs, item))
    }

    fn create_wrap_key(&self, secret: &[u8]) -> Result<(), OsealError> {
        let _one_at_a_time = CREATE.lock().unwrap_or_else(|e| e.into_inner());
        block_on(create_wrap_key(&self.wrap_attrs, secret))
    }

    fn delete_wrap_key(&self) -> Result<(), OsealError> {
        block_on(remove(&self.wrap_attrs))
    }
}
