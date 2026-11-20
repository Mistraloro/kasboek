//! macOS Keychain (login keychain, generic passwords) through `security-framework`.
//!
//! - Electron's item: service `Kasboek Safe Storage`, account `Kasboek` (what Chromium writes for an app named Kasboek).
//!   Read only, to open the old account.json. The first read from a new signature shows the Keychain "allow" prompt.
//! - Ours: service `Kasboek Wrap Key`, account `Kasboek`, 32 raw bytes, used by [`crate::wrap::WrapKeySeal`]. Created with
//!   `SecItemAdd` only (`set_generic_password` would update an existing item), so a second creator gets "duplicate" and
//!   reads the first one's key.
use crate::error::OsealError;
use crate::wrap::{Item, SecretStore};
use core_foundation::data::CFData;
use security_framework::base::Error as SecError;
use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass};
use security_framework::passwords::{delete_generic_password, get_generic_password};
use zeroize::Zeroizing;

pub const ELECTRON_SERVICE: &str = "Kasboek Safe Storage";
pub const WRAP_SERVICE: &str = "Kasboek Wrap Key";
pub const ACCOUNT: &str = "Kasboek";

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_NO_SUCH_KEYCHAIN: i32 = -25294;
const ERR_SEC_NOT_AVAILABLE: i32 = -25291;

pub struct MacKeychain {
    wrap_service: String,
}

impl Default for MacKeychain {
    fn default() -> Self {
        Self { wrap_service: WRAP_SERVICE.to_owned() }
    }
}

impl MacKeychain {
    /// A keychain that keeps the wrap key under another service name (tests use their own, never the real item).
    pub fn with_wrap_service(service: &str) -> Self {
        Self { wrap_service: service.to_owned() }
    }
}

fn map(e: SecError) -> OsealError {
    match e.code() {
        ERR_SEC_ITEM_NOT_FOUND => OsealError::NotFound,
        ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_USER_CANCELED => OsealError::Locked,
        ERR_SEC_NO_SUCH_KEYCHAIN | ERR_SEC_NOT_AVAILABLE => OsealError::Unavailable,
        _ => OsealError::Failed,
    }
}

impl SecretStore for MacKeychain {
    /// Always true: asking would touch the Keychain, and a locked one is only discovered (and unlocked by the user)
    /// when a secret is read or written.
    fn usable(&self) -> bool {
        true
    }

    fn get(&self, item: Item) -> Result<Option<Zeroizing<Vec<u8>>>, OsealError> {
        let service = match item {
            Item::WrapKey => self.wrap_service.as_str(),
            Item::ElectronPassword => ELECTRON_SERVICE,
        };
        match get_generic_password(service, ACCOUNT) {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(e) => match map(e) {
                OsealError::NotFound => Ok(None),
                other => Err(other),
            },
        }
    }

    fn create_wrap_key(&self, secret: &[u8]) -> Result<(), OsealError> {
        let mut add = ItemAddOptions::new(ItemAddValue::Data { class: ItemClass::generic_password(), data: CFData::from_buffer(secret) });
        add.set_service(&self.wrap_service).set_account_name(ACCOUNT).set_label(&self.wrap_service);
        match add.add() {
            Err(e) if e.code() == ERR_SEC_DUPLICATE_ITEM => Ok(()),
            other => other.map_err(map),
        }
    }

    fn delete_wrap_key(&self) -> Result<(), OsealError> {
        match delete_generic_password(&self.wrap_service, ACCOUNT).map_err(map) {
            Err(OsealError::NotFound) => Ok(()),
            other => other,
        }
    }
}
