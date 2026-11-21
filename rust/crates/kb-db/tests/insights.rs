//! The typed queries of the local insights (`queries/insights.rs`) on a fresh database.
use kb_db::queries::insights::InsightsQueries;
use kb_db::{DbKey, OpenOptions, SqliteStore, Store};

fn store() -> (tempfile::TempDir, SqliteStore) {
    let dir = tempfile::tempdir().unwrap();
    let key = DbKey::from_hex("a1a1a1a1a1a1a1a100ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff").unwrap();
    let store = SqliteStore::open(&dir.path().join("kasboek.db"), &key, OpenOptions::default()).unwrap();
    (dir, store)
}

#[test]
fn feedback_is_replaced_per_key_and_restored_by_verdict() {
    let (_dir, store) = store();
    store.insights_feedback_set("a", "dismissed").unwrap();
    store.insights_feedback_set("a", "useful").unwrap();
    store.insights_feedback_set("b", "not_useful").unwrap();
    store.insights_feedback_set("c", "dismissed").unwrap();
    let mut keys = store.insights_dismissed_keys().unwrap();
    keys.sort();
    assert_eq!(keys, ["b", "c"]);
    assert_eq!(store.insights_restore_dismissed().unwrap(), 2);
    assert_eq!(store.insights_restore_dismissed().unwrap(), 0);
    assert!(store.insights_dismissed_keys().unwrap().is_empty());
}

#[test]
fn recent_payments_are_in_date_then_id_order_and_inclusive() {
    let (_dir, store) = store();
    let c = store.connection();
    c.execute("INSERT INTO accounts (name) VALUES ('Main')", []).unwrap();
    for (date, fp) in [("2026-11-03", "1"), ("2026-11-01", "2"), ("2026-11-03", "3"), ("2026-10-31", "4"), ("2026-11-05", "5")] {
        c.execute(
            "INSERT INTO transactions (account_id, booking_date, amount_cents, description, fingerprint) VALUES (1, ?, -100, 'x', ?)",
            [date, fp],
        )
        .unwrap();
    }
    let rows = store.insights_recent_payments("2026-11-01", "2026-11-03").unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.booking_date.as_str(), r.id)).collect::<Vec<_>>(),
        [("2026-11-01", 2), ("2026-11-03", 1), ("2026-11-03", 3)]
    );
    assert_eq!(store.insights_account_currencies().unwrap(), [(1, "EUR".to_owned())]);
}

#[test]
fn stored_tips_and_secrets_are_read_back() {
    let (_dir, store) = store();
    let c = store.connection();
    c.execute("INSERT INTO insights VALUES ('2026-11', 't', 'anthropic', 'm', 'en', 'h', '[]', '[]')", []).unwrap();
    c.execute("INSERT INTO secrets (key, value) VALUES ('k', 'v')", []).unwrap();
    let row = store.insights_row("2026-11").unwrap().unwrap();
    assert_eq!((row.provider.as_str(), row.language.as_str(), row.facts_hash.as_str()), ("anthropic", "en", "h"));
    assert!(store.insights_row("2026-10").unwrap().is_none());
    assert_eq!(store.insights_secret("k").unwrap().as_deref(), Some("v"));
    assert_eq!(store.insights_secret("none").unwrap(), None);
}
