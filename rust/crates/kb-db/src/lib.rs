//! Kasboek storage. Only this crate talks to the database engine (sqlite3mc through rusqlite).
//!
//! - [`Store`] is the boundary `kb-core` will depend on; [`SqliteStore`] implements it.
//! - Opening follows src/core/database.ts exactly: `PRAGMA cipher='chacha20'`, `PRAGMA hexkey`, a probe read, the
//!   pragmas, the migrations, then the `fx()` SQL function.
//! - [`migrations`] holds the 15 migrations, ported one to one; [`sync_schema`] the sync tables and triggers.
//! - No business logic: [`Queries`] holds the typed query helpers `kb-core` uses (all SQL of the business operations is
//!   in `sqlite_queries.rs`), with the plain row structs of [`rows`].
mod dump;
mod error;
mod fx;
mod key;
mod legacy;
pub mod migrations;
pub mod queries;
pub mod rows;
mod sqlite;
mod sqlite_queries;
mod store;
pub mod sync_schema;

pub use error::{DbError, DbResult};
pub use key::DbKey;
pub use migrations::SCHEMA_VERSION;
pub use queries::Queries;
pub use sqlite::SqliteStore;
pub use store::{Cell, OpenOptions, Store, TableDump};
