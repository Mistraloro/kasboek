//! Kasboek storage. Only this crate talks to the database engine (sqlite3mc through rusqlite).
//!
//! - [`Store`] is the boundary `kb-core` will depend on; [`SqliteStore`] implements it.
//! - Opening follows src/core/database.ts exactly: `PRAGMA cipher='chacha20'`, `PRAGMA hexkey`, a probe read, the
//!   pragmas, the migrations, then the `fx()` SQL function.
//! - [`migrations`] holds the 15 migrations, ported one to one; [`sync_schema`] the sync tables and triggers.
//! - No business logic yet: typed queries come with `kb-core` (M2).
mod dump;
mod error;
mod fx;
mod key;
mod legacy;
pub mod migrations;
mod sqlite;
mod store;
pub mod sync_schema;

pub use error::{DbError, DbResult};
pub use key::DbKey;
pub use migrations::SCHEMA_VERSION;
pub use sqlite::SqliteStore;
pub use store::{Cell, OpenOptions, Store};
