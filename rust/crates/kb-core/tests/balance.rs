//! Ports of the bank balance tests of tests/balance.test.ts (the net worth and CSV ones belong to later modules).
use serde_json::json;

mod common;
use common::fresh;

fn set(f: &common::Fixture, account: i64, date: &str, cents: i64) -> serde_json::Value {
    f.ok("balances.set", json!({"accountId": account, "date": date, "balanceCents": cents}))
}

#[test]
fn counts_the_balance_from_what_the_bank_showed_before_and_after_that_day() {
    let f = fresh();
    let acc = f.account("Main");
    f.tx(acc, "2026-10-01", -1000, "a");
    f.tx(acc, "2026-10-05", 50_000, "b");
    f.tx(acc, "2026-10-10", -2000, "c");
    // The bank showed 1,000.00 at the end of 5 October.
    assert!(set(&f, acc, "2026-10-05", 100_000)["differenceCents"].is_null(), "nothing to compare with yet");
    assert_eq!(f.ok("accounts.list", json!({}))[0]["balanceCents"], 98_000);
    // Importing older history later doesn't move today's balance.
    f.tx(acc, "2026-09-15", -30_000, "older");
    assert_eq!(f.ok("accounts.list", json!({}))[0]["balanceCents"], 98_000);
    let list = f.ok("balances.list", json!({"accountId": acc}));
    assert_eq!((list[0]["date"].as_str(), list[0]["since"].as_str()), (Some("2026-10-05"), None));
}

#[test]
fn shows_a_difference_when_a_transaction_is_missing_and_none_once_it_is_there() {
    let f = fresh();
    let acc = f.account("Main");
    f.tx(acc, "2026-10-01", -1000, "a");
    set(&f, acc, "2026-10-01", 20_000);
    f.tx(acc, "2026-10-20", -5000, "b");
    // The bank also booked a 40.00 payment Kasboek doesn't have.
    let r = set(&f, acc, "2026-10-31", 11_000);
    assert_eq!((r["expectedCents"].as_i64(), r["differenceCents"].as_i64()), (Some(15_000), Some(-4000)));
    let first = &f.ok("balances.list", json!({"accountId": acc}))[0];
    assert_eq!(
        (first["date"].as_str(), first["differenceCents"].as_i64(), first["since"].as_str()),
        (Some("2026-10-31"), Some(-4000), Some("2026-10-01"))
    );
    f.tx(acc, "2026-10-25", -4000, "the missing one");
    assert_eq!(f.ok("balances.list", json!({"accountId": acc}))[0]["differenceCents"], 0);
}

#[test]
fn refuses_a_balance_in_the_future_and_on_an_investment_account() {
    let f = fresh();
    let acc = f.account("Main");
    let e = f.op("balances.set", json!({"accountId": acc, "date": "2026-12-01", "balanceCents": 1})).unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("balance.future", "Enter the balance of today or an earlier day."));
    let inv = f.ok("accounts.create", json!({"name": "Broker", "kind": "investment"}))["id"].as_i64().unwrap();
    assert_eq!(f.code("balances.set", json!({"accountId": inv, "date": "2026-10-01", "balanceCents": 100_000})), "balance.investment");
    // An investment has a value; a bank account has no value.
    assert_eq!(f.ok("valuations.set", json!({"accountId": inv, "date": "2026-10-01", "valueCents": 5, "note": " n "}))[0]["note"], "n");
    assert_eq!(f.code("valuations.set", json!({"accountId": acc, "date": "2026-10-01", "valueCents": 5})), "valuations.bank_account");
}
