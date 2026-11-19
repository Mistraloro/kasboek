//! Kasboek account and session (milestones M2/M5): a behaviour-for-behaviour port of src/core/account.ts,
//! src/main/session.ts, src/main/security/account-store.ts and src/main/quarantine.ts.
//!
//! - [`account`]: pure account logic (slots, vault, throttle, remember-2FA, unlock, changes). [`password`]: password rules.
//! - [`store`]: account.json behind the [`seal::OsSeal`] trait; [`oscrypt`]: read-only decoder for Electron's `safeStorage`.
//! - [`quarantine`]: erase/restore. [`device`]: Windows Hello / Touch ID behind a trait.
//! - [`session`]: the state machine (`setup` | `locked` | `unlocked`). [`ops`]: the `auth.*` operations.
//!
//! Time ([`time::Clock`]) and randomness ([`time::Rng`]) are injected. Nothing is decrypted before authentication.
pub mod account;
pub mod device;
pub mod error;
pub mod ops;
pub mod oscrypt;
pub mod password;
pub mod paths;
pub mod quarantine;
pub mod seal;
pub mod session;
pub mod store;
pub mod time;

pub use error::{SessionError, SessionResult};
pub use paths::Paths;
pub use session::{Config, Session};
