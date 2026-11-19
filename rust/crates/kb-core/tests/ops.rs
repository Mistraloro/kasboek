//! Ports of tests/ops.test.ts, the transactions part of tests/finance.test.ts and the dispatch rules of src/main/ipc.ts.
use kb_core::Actor;
use kb_db::{Cell, Store};
use serde_json::json;

mod common;
use common::fresh;

#[test]
fn validates_input_and_normalises_ibans() {
    let f = fresh();
    assert_eq!(f.code("accounts.create", json!({"name": "", "bank": "argenta"})), "op.invalid_input");
    // Any bank name is fine: there is no fixed list.
    assert_eq!(f.ok("accounts.create", json!({"name": "X", "bank": "Mijn Bank"}))["bank"], "Mijn Bank");
    assert_eq!(f.code("accounts.create", json!({"name": "Y", "bank": "x".repeat(61)})), "op.invalid_input");

    let ok = f.ok("accounts.create", json!({"name": "Hello bank!", "bank": "hellobank", "iban": "be68 5390 0754 7034"}));
    assert_eq!(ok["iban"], "BE68539007547034");
    assert_eq!(ok["currency"], "EUR");

    let dup = f.op("accounts.create", json!({"name": "Again", "bank": "hellobank", "iban": "BE68539007547034"})).unwrap_err();
    assert_eq!(dup.code, "accounts.duplicate_iban");
    assert_eq!(dup.message, "An account with this IBAN already exists.");
}

#[test]
fn records_changes_in_the_audit_log_with_the_actor() {
    let f = fresh();
    f.core.dispatch("accounts.create", json!({"name": "Argenta", "bank": "argenta"}), Actor::Assistant).unwrap();
    f.core.dispatch("accounts.list", json!({}), Actor::User).unwrap();
    let log = f.rows("audit_log");
    assert_eq!(log.len(), 1);
    // id, at, actor, action, details
    assert_eq!(log[0][2], Cell::Text("assistant".into()));
    assert_eq!(log[0][3], Cell::Text("accounts.create".into()));
    assert_eq!(
        log[0][4],
        Cell::Text(r#"{"name":"Argenta","bank":"argenta","currency":"EUR","kind":"current","openingBalanceCents":0}"#.into())
    );
}

#[test]
fn rejects_unknown_fields_and_unknown_operations() {
    let f = fresh();
    assert_eq!(f.code("settings.update", json!({"currency": "EUR", "evil": 1})), "op.invalid_input");
    assert_eq!(f.code("nope", json!({})), "op.unknown");
    assert_eq!(f.ok("settings.update", json!({"currency": "USD"}))["currency"], "USD");
}

#[test]
fn only_the_login_operations_run_while_locked() {
    let mut f = fresh();
    f.core.set_unlocked(false);
    for name in ["accounts.list", "settings.get", "transactions.list", "no.such.op"] {
        let e = f.op(name, json!({})).unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("auth.locked", "Kasboek is locked."), "{name}");
    }
    // Public operations go ahead (prefs need no database).
    assert_eq!(f.ok("prefs.get", json!({}))["theme"], "system");
    f.core.set_unlocked(true);
    assert!(f.op("accounts.list", json!({})).is_ok());
}

#[test]
fn a_database_that_is_not_there_answers_locked_not_a_crash() {
    let mut f = fresh();
    f.core.set_store(None);
    assert_eq!(f.code("accounts.list", json!({})), "auth.locked");
}

#[test]
fn rules_categorise_new_transactions_and_search_escapes_wildcards() {
    let f = fresh();
    let acc = f.account("Argenta");
    // The rules operations are not ported yet: the rule is inserted as a row (Groceries is category 3).
    f.sql("INSERT INTO rules (field, pattern, category_id) VALUES ('counterparty', 'delhaize', 3)");
    f.ok("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-03", "amountCents": -800, "description": "Betaling"}));
    f.ok("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-04", "amountCents": -100, "description": "100% fun"}));
    let t = f.ok(
        "transactions.create",
        json!({"accountId": acc, "bookingDate": "2026-10-05", "amountCents": -900, "description": "x", "counterpartyName": "Delhaize Gent"}),
    );
    assert_eq!(t["categoryName"], "Groceries");
    assert_eq!(f.ok("transactions.list", json!({"search": "%"}))["total"], 1);
    assert_eq!(f.ok("transactions.list", json!({"categoryId": "none"}))["total"], 2);
    assert_eq!(f.ok("transactions.list", json!({"month": "2026-10", "direction": "out"}))["outCents"], 1800);
}

#[test]
fn the_account_balance_counts_every_transaction_in_its_own_currency() {
    let f = fresh();
    let acc = f.account("Argenta");
    f.tx(acc, "2026-10-01", 250_000, "Salary");
    f.tx(acc, "2026-10-03", -8_000, "Delhaize");
    f.tx(acc, "2026-10-11", 500, "Refund");
    f.tx(acc, "2026-09-20", -9_999, "Last month");
    let accounts = f.ok("accounts.list", json!({}));
    assert_eq!(accounts[0]["balanceCents"], 250_000 - 8_000 + 500 - 9_999);
    assert_eq!(accounts[0]["balanceMainCents"], 250_000 - 8_000 + 500 - 9_999);
    assert_eq!(accounts[0]["transactionCount"], 4);
    assert!(accounts[0]["lastBankBalance"].is_null());
}

#[test]
fn transactions_are_created_edited_split_and_deleted() {
    let f = fresh();
    let acc = f.account("Main");
    let id = f.tx(acc, "2026-10-01", -1000, "  receipt  ".trim());
    assert_eq!(
        f.code("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-01", "amountCents": 0, "description": "x"})),
        "op.invalid_input"
    );
    assert_eq!(
        f.code("transactions.create", json!({"accountId": 99, "bookingDate": "2026-10-01", "amountCents": 1, "description": "x"})),
        "accounts.not_found"
    );
    assert_eq!(
        f.code(
            "transactions.create",
            json!({"accountId": acc, "bookingDate": "2026-10-01", "amountCents": 1, "description": "x", "categoryId": 99})
        ),
        "categories.not_found"
    );

    let edited = f.ok("transactions.edit", json!({"id": id, "notes": "n", "counterpartyName": "Shop", "categoryId": 3}));
    assert_eq!((edited["notes"].as_str(), edited["categoryName"].as_str()), (Some("n"), Some("Groceries")));
    assert_eq!(f.code("transactions.edit", json!({"id": id, "amountCents": 5})), "op.invalid_input", "the assistant cannot change amounts");
    assert_eq!(f.code("transactions.edit", json!({"id": 77})), "tx.not_found");

    assert_eq!(f.code("transactions.split", json!({"id": id, "parts": [{"categoryId": 3, "amountCents": -1000}]})), "splits.one");
    assert_eq!(
        f.code(
            "transactions.split",
            json!({"id": id, "parts": [{"categoryId": 3, "amountCents": 0}, {"categoryId": 4, "amountCents": -1000}]})
        ),
        "splits.zero"
    );
    assert_eq!(
        f.code(
            "transactions.split",
            json!({"id": id, "parts": [{"categoryId": 3, "amountCents": -500}, {"categoryId": 4, "amountCents": -400}]})
        ),
        "splits.sum"
    );
    let parts = f.ok("transactions.split", json!({"id": id, "parts": [{"categoryId": 3, "amountCents": -600, "note": " food "}, {"categoryId": null, "amountCents": -400, "note": "  "}]}));
    assert_eq!(parts[0]["note"], "food");
    assert!(parts[1]["note"].is_null() && parts[1]["categoryName"].is_null());
    assert_eq!(f.ok("transactions.list", json!({}))["items"][0]["splitCount"], 2);
    assert_eq!(f.ok("transactions.split", json!({"id": id, "parts": []})).as_array().unwrap().len(), 0, "an empty list removes the split");

    assert_eq!(
        f.ok("transactions.categorize", json!({"ids": [id, id, 50], "categoryId": 4}))["updated"],
        2,
        "a duplicate id counts twice, a missing one not at all"
    );
    assert_eq!(f.ok("transactions.rename", json!({"ids": [id], "counterpartyName": "  Carrefour "}))["updated"], 1);
    assert_eq!(f.ok("transactions.delete", json!({"ids": [id, 50]}))["deleted"], 1);
    assert_eq!(f.ok("transactions.list", json!({}))["total"], 0);
}

#[test]
fn list_totals_follow_the_whole_filter_and_convert_to_the_main_currency() {
    let f = fresh();
    let eur = f.account("Eur");
    let usd = f.ok("accounts.create", json!({"name": "Dollar", "currency": "usd"}))["id"].as_i64().unwrap();
    f.sql("INSERT INTO fx_rates (currency, date, per_eur, source) VALUES ('USD', '2026-01-01', 1.25, 'ecb')");
    f.core.db().unwrap().reload_fx_rates().unwrap();
    f.tx(eur, "2026-10-01", -1000, "eur out");
    f.tx(usd, "2026-10-02", 500, "usd in");
    f.tx(usd, "2026-10-03", -250, "usd out");
    let page = f.ok("transactions.list", json!({"limit": 1}));
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!((page["total"].as_i64(), page["inCents"].as_i64(), page["outCents"].as_i64()), (Some(3), Some(400), Some(1200)));
    assert_eq!(f.ok("transactions.list", json!({"accountId": usd, "direction": "out"}))["outCents"], 200);
}

#[test]
fn settings_default_update_and_import_reset() {
    let f = fresh();
    let s = f.ok("settings.get", json!({}));
    assert_eq!(
        (s["currency"].as_str(), s["memoryEnabled"].as_bool(), s["pageContextEnabled"].as_bool()),
        (Some("EUR"), Some(true), Some(true))
    );
    assert_eq!(s["permissions"], json!({"mode": "ask", "rules": {}, "mcpAlwaysAsk": true}));
    f.sql(
        "INSERT INTO settings (key, value) VALUES ('memoryEnabled', 'false'), ('aiProvider', '\"mistral\"'), ('lastBackupAt', 'not json');
           INSERT INTO secrets (key, value) VALUES ('aiKey.mistral', 'invented'), ('other', 'kept');
           INSERT INTO memories (text, source) VALUES ('likes tea', 'person')",
    );
    assert_eq!(f.ok("settings.get", json!({}))["memoryEnabled"], false);
    assert!(f.ok("settings.get", json!({}))["lastBackupAt"].is_null(), "a damaged value falls back to the default");
    let found = kb_core::settings::reset_imported_settings(f.core.db().unwrap(), false).unwrap();
    assert_eq!(found, ["aiKey", "aiEndpoint", "memory"]);
    let s = f.ok("settings.get", json!({}));
    assert_eq!((s["memoryEnabled"].as_bool(), s["aiProvider"].as_str()), (Some(true), Some("anthropic")));
    assert_eq!(f.rows("secrets").len(), 1, "only the AI key went");
    assert_eq!(f.rows("memories").len(), 0);
}

#[test]
fn prefs_are_read_and_written_as_the_typescript_core_does() {
    let f = fresh();
    let path = f.dir.path().join("prefs.json");
    std::fs::write(&path, r#"{"theme":"dark","unknown":[1],"formatLocale":"en-GB"}"#).unwrap();
    let got = f.ok("prefs.get", json!({}));
    assert_eq!(
        (got["theme"].as_str(), got["formats"]["decimal"].as_str(), got["formats"]["currencyPosition"].as_str()),
        (Some("dark"), Some("."), Some("before"))
    );
    let next = f.ok("prefs.update", json!({"graphics": "off", "formats": {"decimal": ","}}));
    assert_eq!(
        (next["graphicsFailed"].as_bool(), next["formats"]["group"].as_str()),
        (Some(false), Some(".")),
        "equal marks are moved apart"
    );
    let file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["unknown"], json!([1]));
    assert!(file.get("formatLocale").is_none());
    // `prefs.update` is not recorded in the audit log.
    assert_eq!(f.rows("audit_log").len(), 0);
}
