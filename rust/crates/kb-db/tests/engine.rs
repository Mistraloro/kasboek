//! The engine and the open sequence: sqlite3mc 2.4.0 on SQLite 3.53.4, chacha20, keys, pragmas, transactions.
use kb_db::{Cell, DbError, DbKey, OpenOptions, SqliteStore, Store, SCHEMA_VERSION};
use std::path::PathBuf;

const KEY: &str = "a1a1a1a1a1a1a1a100ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff";
const WRONG: &str = "0000000000000000000000000000000000000000000000000000000000000001";

fn key(hex: &str) -> DbKey {
    DbKey::from_hex(hex).unwrap()
}

fn fresh() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kasboek.db");
    (dir, file)
}

fn scalar(store: &SqliteStore, sql: &str) -> String {
    use rusqlite::types::Value;
    match store.connection().query_row(sql, [], |r| r.get::<_, Value>(0)).unwrap() {
        Value::Integer(i) => i.to_string(),
        Value::Text(t) => t,
        other => panic!("unexpected {other:?}"),
    }
}

/// Fails when the workspace patch is not in effect (plain SQLite, or another sqlite3mc) or the vendor files changed
/// without VENDOR.md and the Electron side following. See crates/kb-sqlite3mc-sys/VENDOR.md.
#[test]
fn links_sqlite3mc_2_4_0_on_sqlite_3_53_4() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    assert_eq!(scalar(&store, "SELECT sqlite_version()"), "3.53.4");
    assert_eq!(scalar(&store, "SELECT sqlite3mc_version()"), "SQLite3 Multiple Ciphers 2.4.0");
}

#[test]
fn a_new_database_is_migrated_to_the_current_schema() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 15);
    let counts = store.table_counts().unwrap();
    assert_eq!(counts.len(), 24, "{counts:?}");
    assert_eq!(counts.iter().find(|(n, _)| n == "categories").unwrap().1, 16, "the default categories");
    assert!(store.integrity_ok().unwrap());
    assert_eq!(scalar(&store, "PRAGMA foreign_keys"), "1");
    assert_eq!(scalar(&store, "PRAGMA secure_delete"), "1");
    assert_eq!(scalar(&store, "PRAGMA journal_mode"), "delete");
    assert_eq!(scalar(&store, "PRAGMA cipher"), "chacha20");
}

#[test]
fn the_file_is_encrypted_and_a_wrong_key_is_refused() {
    let (_dir, file) = fresh();
    drop(SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap());
    let bytes = std::fs::read(&file).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"), "the header must not be plain");
    assert!(!bytes.windows(8).any(|w| w == b"accounts"), "table names must not be readable");
    assert!(matches!(SqliteStore::open(&file, &key(WRONG), OpenOptions::default()), Err(DbError::Locked)));
    assert!(SqliteStore::open(&file, &key(KEY), OpenOptions::default()).is_ok());
}

#[test]
fn a_changed_file_is_refused() {
    let (_dir, file) = fresh();
    drop(SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap());
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[10] ^= 0xff;
    std::fs::write(&file, bytes).unwrap();
    assert!(matches!(SqliteStore::open(&file, &key(KEY), OpenOptions::default()), Err(DbError::Locked)));
}

#[test]
fn a_database_from_a_newer_version_is_not_touched() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    store.connection().execute_batch("PRAGMA user_version = 16").unwrap();
    drop(store);
    let error = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).err().unwrap();
    assert!(matches!(error, DbError::NewerSchema { found: 16 }), "{error}");
    assert_eq!(error.code(), "db.newer_schema");
}

#[test]
fn opening_without_migrating_keeps_the_schema_as_it_is() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions { migrate: false }).unwrap();
    assert_eq!(store.schema_version().unwrap(), 0);
    assert!(store.table_counts().unwrap().is_empty());
    store.migrate().unwrap();
    assert_eq!(store.schema_version().unwrap(), 15);
}

#[test]
fn transactions_commit_roll_back_and_nest() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    let count = || -> i64 { store.connection().query_row("SELECT count(*) FROM settings", [], |r| r.get(0)).unwrap() };
    let put =
        |k: &str| store.connection().execute("INSERT INTO settings (key, value) VALUES (?1, 'v')", [k]).map(drop).map_err(DbError::from);

    store
        .transaction::<_, DbError, _>(|s| {
            put("a")?;
            let inner: Result<(), DbError> = s.transaction(|_| {
                put("b")?;
                Err(DbError::Locked)
            });
            assert!(inner.is_err());
            s.transaction(|_| put("c"))
        })
        .unwrap();
    assert_eq!(count(), 2, "the failed savepoint is undone, the rest is kept");

    let failed: Result<(), DbError> = store.transaction(|_| {
        put("d")?;
        Err(DbError::Locked)
    });
    assert!(failed.is_err());
    assert_eq!(count(), 2);
}

#[test]
fn snapshots_stay_encrypted_with_the_same_key() {
    let (dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    store.connection().execute("INSERT INTO accounts (name, currency) VALUES ('Invented', 'EUR')", []).unwrap();
    let copy = dir.path().join("snapshot.db");
    store.snapshot_encrypted(&copy).unwrap();
    assert!(!std::fs::read(&copy).unwrap().starts_with(b"SQLite format 3"));
    assert!(matches!(SqliteStore::open(&copy, &key(WRONG), OpenOptions::default()), Err(DbError::Locked)));
    let reopened = SqliteStore::open(&copy, &key(KEY), OpenOptions::default()).unwrap();
    assert_eq!(reopened.canonical_dump().unwrap(), store.canonical_dump().unwrap());
}

#[test]
fn the_fx_function_converts_through_the_euro_and_returns_reals() {
    let (_dir, file) = fresh();
    let store = SqliteStore::open(&file, &key(KEY), OpenOptions::default()).unwrap();
    store
        .connection()
        .execute_batch("INSERT INTO fx_rates (currency, date, per_eur, source) VALUES ('USD', '2025-01-01', 1.25, 'ecb')")
        .unwrap();
    let fx = |cents: Cell, from: &str, date: &str, to: &str| {
        store.probe_fx([cents, Cell::Text(from.into()), Cell::Text(date.into()), Cell::Text(to.into())]).unwrap()
    };
    // Rates are loaded when the store opens or when told: not yet.
    assert_eq!(fx(Cell::Int(1000), "EUR", "2025-02-01", "USD"), Cell::Null);
    store.reload_fx_rates().unwrap();
    assert_eq!(fx(Cell::Int(1000), "EUR", "2025-02-01", "USD"), Cell::Real(1250.0));
    assert_eq!(fx(Cell::Int(1250), "USD", "2025-02-01", "EUR"), Cell::Real(1000.0));
    assert_eq!(fx(Cell::Int(7), "GBP", "2025-02-01", "GBP"), Cell::Real(7.0), "same currency");
    assert_eq!(fx(Cell::Int(7), "GBP", "2025-02-01", "EUR"), Cell::Null, "no rate at all");
    assert_eq!(fx(Cell::Null, "EUR", "2025-02-01", "USD"), Cell::Null);
    assert_eq!(fx(Cell::Text("1000".into()), "EUR", "2025-02-01", "USD"), Cell::Null, "only numbers convert");
}

#[test]
fn bad_keys_are_refused_before_the_file_is_touched() {
    assert!(matches!(DbKey::from_hex("zz"), Err(DbError::BadKey)));
    assert_eq!(DbError::BadKey.code(), "db.bad_key");
}
