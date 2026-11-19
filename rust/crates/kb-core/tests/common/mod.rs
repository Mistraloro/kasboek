//! Shared helpers of the kb-core integration tests. All data is invented.
#![allow(dead_code)]
use kb_core::{Actor, AppError, Core, CoreConfig, FixedClock, SeededRng};
use kb_db::{DbKey, OpenOptions, SqliteStore, Store};
use serde_json::{json, Value};

pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub core: Core<SqliteStore>,
}

/// 2026-11-14T10:00:00Z.
pub const NOW_MS: i64 = 1_794_650_400_000;

/// A fresh encrypted database, unlocked, with the clock fixed on 2026-11-14.
pub fn fresh() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let key = DbKey::from_hex(&"a1".repeat(32)).unwrap();
    let store = SqliteStore::open(&dir.path().join("kasboek.db"), &key, OpenOptions::default()).unwrap();
    let core = Core::new(
        Some(store),
        Box::new(FixedClock { ms: NOW_MS, utc_offset_minutes: 0 }),
        Box::new(SeededRng::new(1)),
        CoreConfig { prefs_file: Some(dir.path().join("prefs.json")), system_languages: vec!["en".into()] },
    );
    Fixture { dir, core }
}

impl Fixture {
    pub fn op(&self, name: &str, input: Value) -> Result<Value, AppError> {
        self.core.dispatch(name, input, Actor::User)
    }

    /// The result of an operation that must succeed.
    pub fn ok(&self, name: &str, input: Value) -> Value {
        self.op(name, input).unwrap_or_else(|e| panic!("{name} failed: {e}"))
    }

    /// The error code of an operation that must fail.
    pub fn code(&self, name: &str, input: Value) -> String {
        self.op(name, input).expect_err(name).code
    }

    pub fn sql(&self, sql: &str) {
        self.core.db().unwrap().execute_script(sql).unwrap();
    }

    /// The rows of a table as arrays, in rowid order.
    pub fn rows(&self, table: &str) -> Vec<Vec<kb_db::Cell>> {
        let dump = self.core.db().unwrap().dump_tables().unwrap();
        dump.into_iter().find(|t| t.name == table).unwrap().rows
    }

    pub fn account(&self, name: &str) -> i64 {
        self.ok("accounts.create", json!({ "name": name }))["id"].as_i64().unwrap()
    }

    /// Creates a transaction and returns its id.
    pub fn tx(&self, account: i64, date: &str, cents: i64, description: &str) -> i64 {
        self.ok(
            "transactions.create",
            json!({ "accountId": account, "bookingDate": date, "amountCents": cents, "description": description }),
        )["id"]
            .as_i64()
            .unwrap()
    }
}
