//! The operating system seal around account.json for the native app: real [`kb_session::seal::OsSeal`]
//! implementations per OS, plus what is needed to read (and migrate from) the files Electron's `safeStorage` wrote.
//! Plan: docs/rust-port-plan.md sections 4 and 10.
//!
//! | OS | Seal | Blob | Where the key lives |
//! |---|---|---|---|
//! | Windows | [`dpapi::DpapiSeal`] | `KBD1 \|\| DPAPI blob` (user scope, entropy `kasboek:oseal:dpapi:v1`) | the user's DPAPI master key |
//! | macOS | [`wrap::WrapKeySeal`] over [`keychain::MacKeychain`] | `KBK1 \|\| iv(12) \|\| ct \|\| tag(16)`, AES-256-GCM | Keychain item `Kasboek Wrap Key` / `Kasboek` |
//! | Linux | [`wrap::WrapKeySeal`] over [`secret_service::SecretService`] | as macOS | Secret Service item `service=Kasboek`, `account=wrap-key` |
//!
//! Native seals write `seal:'os-native'` to account.json (`OsSeal::seal_value`); `seal:'os'` stays Electron's.
//! **The app calls [`select_os_seal_for`]`(data_dir)`** and hands the result to `kb_session::Config::new`
//! (kb-oseal depends on kb-session, so the glue lives here). [`select_os_seal`] is the same without the check for a
//! stale wrap key. Without a keyring (Linux) the seal reports `available() == false`, the store writes `seal:'none'`,
//! which is only acceptable for password accounts: kb-session refuses to write a device-mode account then. The
//! answer is asked again later, so a keyring that starts after the app is used from then on.
//! [`legacy`] has the Electron key providers, `open_electron_account_json` and the migration.
//!
//! The OS calls sit behind [`dpapi::DpapiApi`] and [`wrap::SecretStore`]; unit tests use fakes. Secrets are `Zeroizing`
//! and no type here prints them. All calls block: use them from the worker thread that owns the session.
pub mod dpapi;
pub mod error;
pub mod legacy;
pub mod wrap;

#[cfg(target_os = "macos")]
pub mod keychain;
#[cfg(target_os = "linux")]
pub mod secret_service;

pub use error::OsealError;
pub use legacy::{holds_native_account, open_electron_account_json, plan_migration, MigrationPlan};

use kb_session::seal::OsSeal;
use std::path::Path;

/// The seal of this platform for the data folder `data_dir`. When that folder has no native-sealed account (nor an
/// erased copy of one), a wrap key already in the Keychain / Secret Service was not made for this data, so the first
/// `seal` deletes it and makes a fresh one instead of adopting it. Use this one in the app.
pub fn select_os_seal_for(data_dir: &Path) -> Box<dyn OsSeal> {
    build(!holds_native_account(data_dir))
}

/// The seal of this platform that adopts an existing wrap key, as `safeStorage` is for the TypeScript app.
pub fn select_os_seal() -> Box<dyn OsSeal> {
    build(false)
}

#[cfg_attr(windows, allow(unused_variables))]
fn build(replace_stale_key: bool) -> Box<dyn OsSeal> {
    #[cfg(windows)]
    return Box::new(dpapi::DpapiSeal::new(dpapi::SystemDpapi));
    #[cfg(target_os = "macos")]
    return Box::new(wrap_seal(keychain::MacKeychain::default(), replace_stale_key));
    #[cfg(target_os = "linux")]
    return Box::new(wrap_seal(secret_service::SecretService::new(), replace_stale_key));
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Box::new(kb_session::seal::Unsupported)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn wrap_seal<S: wrap::SecretStore>(store: S, replace_stale_key: bool) -> wrap::WrapKeySeal<S> {
    if replace_stale_key {
        wrap::WrapKeySeal::replacing_stale_key(store)
    } else {
        wrap::WrapKeySeal::new(store)
    }
}
