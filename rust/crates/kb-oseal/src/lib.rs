//! The operating system seal around account.json for the native app: real [`kb_session::seal::OsSeal`]
//! implementations per OS, plus what is needed to read (and migrate from) the files Electron's `safeStorage` wrote.
//! Plan: docs/rust-port-plan.md sections 4 and 10.
//!
//! | OS | Seal | Blob | Where the key lives |
//! |---|---|---|---|
//! | Windows | [`dpapi::DpapiSeal`] | `KBD1 \|\| DPAPI blob` (user scope, entropy `kasboek:oseal:dpapi:v1`) | the user's DPAPI master key |
//! | macOS | [`wrap::WrapKeySeal`] over [`keychain::MacKeychain`] | `KBK1 \|\| iv(12) \|\| ct \|\| tag(16)`, AES-256-GCM | Keychain item `Kasboek Wrap Key` / `Kasboek` |
//! | Linux | [`wrap::WrapKeySeal`] over [`secret_service::SecretService`] | as macOS | Secret Service item `service=Kasboek`, `account=wrap-key` |
//! | Linux, no keyring | [`kb_session::seal::Unsupported`] | none: account.json gets `seal:'none'` | |
//!
//! `select_os_seal()` picks the right one. The no-keyring fallback is only acceptable for password accounts:
//! kb-session's store refuses to write a device-mode account without an available seal.
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
pub use legacy::{open_electron_account_json, plan_migration, MigrationPlan};

use kb_session::seal::OsSeal;

/// The seal of this platform, as `safeStorage` is for the TypeScript app.
pub fn select_os_seal() -> Box<dyn OsSeal> {
    #[cfg(windows)]
    return Box::new(dpapi::DpapiSeal::new(dpapi::SystemDpapi));
    #[cfg(target_os = "macos")]
    return Box::new(wrap::WrapKeySeal::new(keychain::MacKeychain::default()));
    #[cfg(target_os = "linux")]
    return {
        let seal = wrap::WrapKeySeal::new(secret_service::SecretService::new());
        if seal.available() {
            Box::new(seal)
        } else {
            Box::new(kb_session::seal::Unsupported)
        }
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Box::new(kb_session::seal::Unsupported)
}
