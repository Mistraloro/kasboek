//! The storage boundary. Only this crate talks to the database engine; `kb-core` will depend on [`Store`] only.
//! Typed query helpers and change hooks join the trait with the business logic (M2); M1 has what the compatibility
//! work needs.
use crate::error::{DbError, DbResult};
use crate::key::DbKey;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    /// Bring the schema up to date after unlocking (the default). Off: read a database as it is.
    pub migrate: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self { migrate: true }
    }
}

/// An engine-neutral value, for conformance probes and dumps.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

pub trait Store: Sized + crate::Queries {
    /// Opens or creates the encrypted database: cipher, key, probe (fails with `db.locked` on a wrong key), pragmas,
    /// migrations (unless switched off), then the `fx()` SQL function.
    fn open(file: &Path, key: &DbKey, options: OpenOptions) -> DbResult<Self>;

    /// `PRAGMA user_version`.
    fn schema_version(&self) -> DbResult<u32>;

    /// Applies the missing migrations up to [`crate::SCHEMA_VERSION`], each in its own transaction. Refuses a
    /// database from a newer version.
    fn migrate(&self) -> DbResult<()> {
        self.migrate_to(crate::SCHEMA_VERSION)
    }

    /// Like `migrate`, but stops at `target` (1 to the current version): the migration paths of the conformance suite.
    /// Does nothing if the database is already at or past `target`.
    fn migrate_to(&self, target: u32) -> DbResult<()>;

    /// Runs `work` in a transaction: committed on `Ok`, rolled back on `Err`. Nested calls become savepoints. The error
    /// type is the caller's, as long as a storage error converts into it.
    fn transaction<T, E: From<DbError>, F: FnOnce(&Self) -> Result<T, E>>(&self, work: F) -> Result<T, E>;

    /// Reloads the exchange rates the `fx()` function uses. Call after the rates table changes (`fxChanged`).
    fn reload_fx_rates(&self) -> DbResult<()>;

    /// Evaluates the SQL function `fx(cents, from, date, to)` with arbitrary argument values.
    fn probe_fx(&self, args: [Cell; 4]) -> DbResult<Cell>;

    /// `PRAGMA quick_check` says "ok".
    fn integrity_ok(&self) -> DbResult<bool>;

    /// A consistent copy that is still encrypted with the same cipher and key (`VACUUM INTO`).
    fn snapshot_encrypted(&self, target: &Path) -> DbResult<()>;

    /// Row count per user table, ordered by name.
    fn table_counts(&self) -> DbResult<Vec<(String, i64)>>;

    /// Schema (tables, indexes, views, triggers, with their SQL text), `user_version` and all rows, as stable text.
    /// Random ids (`uid` columns) are masked. Two stores with equal dumps hold the same data and schema.
    fn canonical_dump(&self) -> DbResult<String>;

    /// Every user table with its column names and all rows in rowid order, values as the engine holds them. For the
    /// scenario harness, which masks random and time columns itself.
    fn dump_tables(&self) -> DbResult<Vec<TableDump>>;

    /// Runs SQL text (several statements). For tests and the scenario harness that seed invented rows; the app never
    /// calls it.
    fn execute_script(&self, sql: &str) -> DbResult<()>;
}

/// One table as `Store::dump_tables` returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct TableDump {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}
