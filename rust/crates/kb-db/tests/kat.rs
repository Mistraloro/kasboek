//! Known-answer and differential tests on the fixtures made by the TypeScript core (rust/parity/fixtures, invented).
use kb_db::{DbKey, OpenOptions, SqliteStore, Store};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/fixtures")
}

fn kat() -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join("kat.json")).expect("fixtures/kat.json")).expect("valid JSON")
}

fn key(kat: &Value) -> DbKey {
    DbKey::from_hex(kat["dbKeyHex"].as_str().unwrap()).unwrap()
}

fn open(file: &Path, kat: &Value, migrate: bool) -> SqliteStore {
    SqliteStore::open(file, &key(kat), OpenOptions { migrate }).unwrap_or_else(|e| panic!("{}: {e}", file.display()))
}

#[test]
fn typescript_databases_open_with_the_same_versions_and_counts() {
    let kat = kat();
    for entry in kat["db"].as_object().unwrap().values() {
        let file = fixtures().join(entry["file"].as_str().unwrap());
        let store = open(&file, &kat, false);
        assert_eq!(u64::from(store.schema_version().unwrap()), entry["userVersion"].as_u64().unwrap(), "{file:?}");
        let counts: Vec<(String, i64)> =
            entry["tables"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_i64().unwrap())).collect();
        assert_eq!(store.table_counts().unwrap(), counts, "{file:?}");
        assert!(store.integrity_ok().unwrap());
    }
}

#[test]
fn migrating_the_schema_1_database_gives_what_typescript_gets() {
    let kat = kat();
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("schema1.db");
    std::fs::copy(fixtures().join("schema1.db"), &copy).unwrap();
    let rust = open(&copy, &kat, true);
    assert_eq!(rust.schema_version().unwrap(), 15);
    let ts = open(&fixtures().join("schema1-migrated-by-ts.db"), &kat, false);
    let (rust_dump, ts_dump) = (rust.canonical_dump().unwrap(), ts.canonical_dump().unwrap());
    assert_eq!(rust_dump.lines().collect::<Vec<_>>(), ts_dump.lines().collect::<Vec<_>>());
    assert!(rust_dump.contains("CREATE TRIGGER sync_rules_ins"));
}

#[test]
fn every_migration_path_ends_in_the_same_schema() {
    let kat = kat();
    let dir = tempfile::tempdir().unwrap();
    let reference = open(&dir.path().join("direct.db"), &kat, true).canonical_dump().unwrap();
    for n in 1..=15u32 {
        let file = dir.path().join(format!("step{n}.db"));
        let store = open(&file, &kat, false);
        store.migrate_to(n).unwrap();
        assert_eq!(store.schema_version().unwrap(), n);
        store.migrate().unwrap();
        assert_eq!(store.canonical_dump().unwrap(), reference, "path from {n}");
    }
}

#[test]
fn a_database_made_by_typescript_at_schema_15_is_not_changed_by_opening() {
    let kat = kat();
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("schema15.db");
    std::fs::copy(fixtures().join("schema15.db"), &copy).unwrap();
    let before = open(&copy, &kat, false).canonical_dump().unwrap();
    assert_eq!(open(&copy, &kat, true).canonical_dump().unwrap(), before);
    assert!(before.contains("Invented Café ☕"));
}
