//! Ports of the TypeScript unit tests of the slice 2 operations: tests/finance.test.ts (budgets, summaries, rules),
//! tests/features.test.ts (transfers, fixed costs, review, warnings, goals, net worth ranges), tests/recurring-hide.test.ts,
//! tests/recurring-cache.test.ts and tests/wealth.test.ts. All data is invented.
use kb_core::alerts::list_alerts;
use kb_core::goals::list_goals;
use kb_core::recurring::{find_recurring, set_recurring_hidden};
use kb_core::review::month_review;
use kb_core::transfers::find_transfers;
use kb_core::wealth::net_worth;
use kb_db::Store;
use serde_json::{json, Value};

mod common;
use common::{fresh, Fixture};

/// A result as `dispatch` hands it out: whole floats are integers, like in JavaScript.
fn to_value<T: serde::Serialize>(t: T) -> Result<Value, serde_json::Error> {
    let mut v = serde_json::to_value(t)?;
    kb_core::numbers::normalize(&mut v);
    Ok(v)
}

fn account(f: &Fixture, input: Value) -> i64 {
    f.ok("accounts.create", input)["id"].as_i64().unwrap()
}

fn category(f: &Fixture, name: &str) -> i64 {
    f.ok("categories.list", json!({})).as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["id"].as_i64().unwrap()
}

/// A transaction with a counterparty name and (optionally) a category.
fn pay(f: &Fixture, account: i64, date: &str, cents: i64, name: &str, category_id: Option<i64>) -> i64 {
    f.ok(
        "transactions.create",
        json!({"accountId": account, "bookingDate": date, "amountCents": cents, "description": format!("{name} {date}"), "counterpartyName": name, "categoryId": category_id}),
    )["id"]
        .as_i64()
        .unwrap()
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn budgets_and_summaries_count_refunds_and_leave_transfers_out() {
    let f = fresh();
    let acc = account(&f, json!({"name": "Argenta", "bank": "argenta"}));
    let (salary, groceries, transfers) = (category(&f, "Salary"), category(&f, "Groceries"), category(&f, "Own transfers"));
    pay(&f, acc, "2026-10-01", 250_000, "Salary", Some(salary));
    pay(&f, acc, "2026-10-03", -8000, "Delhaize", Some(groceries));
    pay(&f, acc, "2026-10-10", -2000, "Colruyt", Some(groceries));
    pay(&f, acc, "2026-10-11", 500, "Refund Colruyt", Some(groceries));
    pay(&f, acc, "2026-10-15", -50_000, "To savings", Some(transfers));
    pay(&f, acc, "2026-10-20", -1500, "Unknown shop", None);
    pay(&f, acc, "2026-09-20", -9999, "Last month", None);
    f.ok("budgets.set", json!({"categoryId": groceries, "month": "2026-10", "amountCents": 30_000}));

    let s = f.ok("summary.month", json!({"month": "2026-10"}));
    assert_eq!(s["incomeCents"], 250_000, "the refund lowers spending, it is not income");
    assert_eq!(s["spendingCents"], 11_000, "transfers excluded");
    assert_eq!(s["budgetedCents"], 30_000);
    assert_eq!(s["leftCents"], 30_000 - 9500);
    assert_eq!((s["byCategory"][0]["name"].as_str(), s["byCategory"][0]["cents"].clone()), (Some("Groceries"), json!(9500)));
    assert_eq!(s["uncategorized"], 1);
    assert_eq!(s["history"].as_array().unwrap().len(), 6);
    assert_eq!(s["history"][5]["month"], "2026-10");

    assert_eq!(f.ok("budgets.copyPrevious", json!({"month": "2026-11"}))["copied"], 1);
    assert_eq!(f.code("budgets.set", json!({"categoryId": salary, "month": "2026-10", "amountCents": 1})), "budgets.not_expense");
    assert_eq!(f.ok("accounts.list", json!({}))[0]["balanceCents"], 250_000 - 8000 - 2000 + 500 - 50_000 - 1500 - 9999);
}

#[test]
fn rules_categorise_existing_and_new_transactions() {
    let f = fresh();
    let acc = account(&f, json!({"name": "Argenta"}));
    let groceries = category(&f, "Groceries");
    f.ok("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-03", "amountCents": -800, "description": "Betaling", "counterpartyName": "DELHAIZE BRUSSEL"}));
    f.ok("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-04", "amountCents": -100, "description": "100% fun"}));
    let r = f.ok("rules.create", json!({"field": "counterparty", "pattern": "delhaize", "categoryId": groceries}));
    assert_eq!(r["applied"], 1);
    assert_eq!((r["rule"]["match"].as_str(), r["rule"]["priority"].clone()), (Some("contains"), json!(0)));
    let t = f.ok("transactions.create", json!({"accountId": acc, "bookingDate": "2026-10-05", "amountCents": -900, "description": "x", "counterpartyName": "Delhaize Gent"}));
    assert_eq!(t["categoryName"], "Groceries");
    assert_eq!(f.ok("transactions.list", json!({"search": "%"}))["total"], 1);
    assert_eq!(f.ok("transactions.list", json!({"categoryId": "none"}))["total"], 1);
    assert_eq!(f.ok("transactions.list", json!({"month": "2026-10", "direction": "out"}))["outCents"], 1800);
}

#[test]
fn short_rule_texts_become_whole_word_rules_and_reordering_sets_priorities() {
    let f = fresh();
    account(&f, json!({"name": "Main"}));
    let r = f.ok("rules.create", json!({"field": "any", "pattern": "q8", "categoryId": 6}));
    assert_eq!(r["rule"]["match"], "word");
    let long = f.ok("rules.create", json!({"field": "any", "pattern": "shell", "categoryId": 6}));
    assert_eq!(long["rule"]["match"], "contains");
    assert_eq!(f.code("rules.create", json!({"field": "any", "pattern": "SHELL", "categoryId": 7})), "rules.duplicate");
    let order = f.ok("rules.reorder", json!({"ids": [2, 1]}));
    assert_eq!(
        order.as_array().unwrap().iter().map(|r| (r["id"].as_i64().unwrap(), r["priority"].as_i64().unwrap())).collect::<Vec<_>>(),
        [(2, 2), (1, 1)]
    );
    assert_eq!(f.code("rules.update", json!({"id": 9, "pattern": "zz"})), "rules.not_found");
    assert_eq!(f.ok("rules.delete", json!({"id": 2})).as_array().unwrap().len(), 1);
}

#[test]
fn net_worth_values_accounts_from_transactions_or_recorded_values() {
    let f = fresh();
    let current = account(&f, json!({"name": "Current", "openingBalanceCents": 100_000}));
    let broker = account(&f, json!({"name": "Broker", "kind": "investment"}));
    let card = account(&f, json!({"name": "Card", "kind": "credit_card"}));
    pay(&f, current, "2026-01-10", -50_000, "To broker", None);
    pay(&f, broker, "2026-01-10", 50_000, "Deposit", None);
    pay(&f, card, "2026-02-03", -12_000, "Shop", None);
    f.ok("valuations.set", json!({"accountId": broker, "date": "2026-01-31", "valueCents": 55_000}));
    pay(&f, broker, "2026-03-05", 10_000, "Deposit", None);

    let nw = to_value(net_worth(f.core.db().unwrap(), 0, "2026-03-15").unwrap()).unwrap();
    let b = nw["accounts"].as_array().unwrap().iter().find(|a| a["id"] == broker).unwrap();
    assert_eq!((b["valueCents"].clone(), b["investedCents"].clone(), b["gainCents"].clone()), (json!(65_000), json!(60_000), json!(5000)));
    assert_eq!(nw["assetsCents"], 50_000.0 + 65_000.0);
    assert_eq!(nw["liabilitiesCents"], -12_000.0);
    assert_eq!(nw["totalCents"], 103_000.0);
    let months: Vec<&str> = nw["history"].as_array().unwrap().iter().map(|h| h["month"].as_str().unwrap()).collect();
    assert_eq!(months, ["2026-01", "2026-02", "2026-03"]);
    let cents: Vec<f64> = nw["history"].as_array().unwrap().iter().map(|h| h["cents"].as_f64().unwrap()).collect();
    assert_eq!(cents, [105_000.0, 93_000.0, 103_000.0], "January end: 50,000 current + 55,000 portfolio; February adds the card debt");
}

#[test]
fn net_worth_converts_other_currencies_at_each_month_end_rate() {
    let f = fresh();
    let usd = account(&f, json!({"name": "USD", "currency": "USD"}));
    pay(&f, usd, "2026-01-05", 110_000, "In", None);
    f.sql("INSERT INTO fx_rates (currency, date, per_eur, source) VALUES ('USD','2026-02-27',1.2,'ecb'),('USD','2026-01-30',1.1,'ecb')");
    f.core.db().unwrap().reload_fx_rates().unwrap();
    let nw = to_value(net_worth(f.core.db().unwrap(), 0, "2026-02-28").unwrap()).unwrap();
    let cents: Vec<f64> = nw["history"].as_array().unwrap().iter().map(|h| h["cents"].as_f64().unwrap()).collect();
    assert_eq!(cents, [100_000.0, 91_667.0]);
}

#[test]
fn net_worth_ranges_start_at_the_first_month_with_data() {
    let f = fresh();
    let a = account(&f, json!({"name": "Current"}));
    pay(&f, a, "2022-03-10", 100_000, "x", None);
    pay(&f, a, "2026-10-10", -1000, "y", None);
    let len = |months| net_worth(f.core.db().unwrap(), months, "2026-11-10").unwrap().history.len();
    assert_eq!([len(12), len(24), len(60), len(0)], [12, 24, 57, 57]);
    assert_eq!(net_worth(f.core.db().unwrap(), 0, "2026-11-10").unwrap().first_month.as_deref(), Some("2022-03"));
}

#[test]
fn the_year_view_sums_per_month_and_category_without_transfers() {
    let f = fresh();
    let acc = account(&f, json!({"name": "Current"}));
    let (salary, groceries, own) = (category(&f, "Salary"), category(&f, "Groceries"), category(&f, "Own transfers"));
    pay(&f, acc, "2026-01-01", 250_000, "a", Some(salary));
    pay(&f, acc, "2026-01-05", -8000, "b", Some(groceries));
    pay(&f, acc, "2026-01-06", 1000, "c", Some(groceries));
    pay(&f, acc, "2026-03-05", -9000, "d", Some(groceries));
    pay(&f, acc, "2026-03-07", -40_000, "e", Some(own));
    pay(&f, acc, "2025-12-20", -5000, "f", Some(groceries));
    let y = f.ok("summary.year", json!({"year": 2026}));
    assert_eq!((y["incomeCents"].clone(), y["spendingCents"].clone()), (json!(250_000), json!(16_000)));
    assert_eq!((y["months"][0]["month"].as_str(), y["months"][0]["spendingCents"].clone()), (Some("2026-01"), json!(7000)));
    let g = y["categories"].as_array().unwrap().iter().find(|c| c["name"] == "Groceries").unwrap();
    assert_eq!((g["months"][0].clone(), g["months"][2].clone(), g["totalCents"].clone()), (json!(7000), json!(9000), json!(16_000)));
    assert_eq!(y["categories"][0]["kind"], "income");
    assert!(!names(&y["categories"]).contains(&"Own transfers".to_owned()));
    assert_eq!(y["years"].as_array().unwrap().iter().map(|r| r["year"].as_i64().unwrap()).collect::<Vec<_>>(), [2025, 2026]);
}

#[test]
fn the_year_view_lists_uncategorised_money_in_under_income_and_out_under_spending() {
    let f = fresh();
    let acc = account(&f, json!({"name": "Current"}));
    f.tx(acc, "2026-02-01", 30_000, "in");
    f.tx(acc, "2026-02-02", -2000, "out");
    let y = f.ok("summary.year", json!({"year": 2026}));
    let rows: Vec<Value> =
        y["categories"].as_array().unwrap().iter().map(|c| json!([c["kind"], c["categoryId"], c["totalCents"]])).collect();
    assert_eq!(rows, [json!(["income", null, 30_000]), json!(["expense", null, 2000])]);
}

const TODAY: &str = "2026-11-10";

fn fixed_costs(f: &Fixture) -> i64 {
    let a = account(f, json!({"name": "Current"}));
    for m in ["2026-07", "2026-08", "2026-09", "2026-10"] {
        pay(f, a, &format!("{m}-05"), -1200, "Streamly", None);
        pay(f, a, &format!("{m}-20"), -90_000, "Flat Owner", None);
        pay(f, a, &format!("{m}-25"), 200_000, "Acme Payroll", None);
    }
    a
}

fn key_of(list: &[kb_core::recurring::RecurringItem], name: &str) -> String {
    list.iter().find(|i| i.name == name).unwrap().key.clone()
}

#[test]
fn hiding_a_fixed_cost_leaves_it_out_of_the_totals_and_showing_it_restores_it() {
    let f = fresh();
    fixed_costs(&f);
    let before = find_recurring(&f.core, TODAY).unwrap();
    assert!(before.hidden.is_empty());
    assert_eq!(before.monthly_out_cents, 91_200);
    let key = key_of(&before.items, "Streamly");
    assert!(key.starts_with("out:"));
    let after = set_recurring_hidden(&f.core, &key, true, TODAY).unwrap();
    let mut shown: Vec<&str> = after.items.iter().map(|i| i.name.as_str()).collect();
    shown.sort_unstable();
    assert_eq!(shown, ["Acme Payroll", "Flat Owner"]);
    assert_eq!(after.hidden.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Streamly"]);
    assert_eq!(after.monthly_out_cents, 90_000);
    assert_eq!(after.due_this_month_cents, before.due_this_month_cents - 1200);
    let again = set_recurring_hidden(&f.core, &key, false, TODAY).unwrap();
    assert_eq!(to_value(&again).unwrap(), to_value(&before).unwrap());
}

#[test]
fn a_hidden_item_stays_hidden_when_a_new_payment_arrives() {
    let f = fresh();
    let a = fixed_costs(&f);
    let found = find_recurring(&f.core, TODAY).unwrap();
    let salary = key_of(&found.items, "Acme Payroll");
    assert!(salary.starts_with("in:"));
    set_recurring_hidden(&f.core, &salary, true, TODAY).unwrap();
    pay(&f, a, "2026-11-05", -1200, "Streamly", None);
    pay(&f, a, "2026-11-25", 200_000, "Acme Payroll", None);
    let r = find_recurring(&f.core, "2026-11-26").unwrap();
    assert_eq!(r.hidden.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Acme Payroll"]);
    assert!(r.items.iter().all(|i| i.direction != "in"));
    assert_eq!(r.monthly_in_cents, 0);
}

#[test]
fn an_unknown_key_is_refused_and_each_item_keeps_one_mark() {
    let f = fresh();
    fixed_costs(&f);
    assert_eq!(set_recurring_hidden(&f.core, "out:nobody", true, TODAY).unwrap_err().code, "recurring.not_found");
    assert!(f.rows("recurring_marks").is_empty());
    set_recurring_hidden(&f.core, "out:nobody", false, TODAY).unwrap();
    let key = key_of(&find_recurring(&f.core, TODAY).unwrap().items, "Streamly");
    for hidden in [true, false, true] {
        set_recurring_hidden(&f.core, &key, hidden, TODAY).unwrap();
    }
    let marks = f.rows("recurring_marks");
    assert_eq!(marks.len(), 1, "never deleted, so the row stays");
    assert_eq!(marks[0][2], kb_db::Cell::Int(1));
}

#[test]
fn hidden_items_are_left_out_of_the_balance_warning() {
    let f = fresh();
    let a = fixed_costs(&f);
    f.ok("balances.set", json!({"accountId": a, "date": "2026-11-14", "balanceCents": 50_000}));
    let balance_alert = |today: &str| list_alerts(&f.core, today).unwrap().into_iter().find(|x| x["kind"] == "balance");
    assert_eq!(balance_alert("2026-11-10").unwrap()["dueCents"], 90_000);
    set_recurring_hidden(&f.core, &key_of(&find_recurring(&f.core, TODAY).unwrap().items, "Flat Owner"), true, TODAY).unwrap();
    assert!(balance_alert("2026-11-10").is_none());
}

#[test]
fn the_recurring_list_follows_every_change_in_between() {
    let f = fresh();
    let a = fixed_costs(&f);
    let first = to_value(find_recurring(&f.core, TODAY).unwrap()).unwrap();
    assert_eq!(to_value(find_recurring(&f.core, TODAY).unwrap()).unwrap(), first);
    assert_eq!(names(&first["items"]), ["Acme Payroll", "Flat Owner", "Streamly"]);
    let hidden = set_recurring_hidden(&f.core, first["items"][0]["key"].as_str().unwrap(), true, TODAY).unwrap();
    assert_eq!(to_value(find_recurring(&f.core, TODAY).unwrap()).unwrap(), to_value(&hidden).unwrap());
    // A payment added since is seen, and so is another day.
    pay(&f, a, "2026-11-05", -1200, "Streamly", None);
    let with_new = find_recurring(&f.core, TODAY).unwrap();
    assert_eq!(with_new.items.iter().find(|i| i.name == "Streamly").unwrap().count, 5);
    assert_eq!(find_recurring(&f.core, "2026-12-20").unwrap().items.iter().find(|i| i.name == "Streamly").unwrap().status, "late");
}

#[test]
fn finds_what_comes_back_what_is_due_price_changes_and_late_payments() {
    let f = fresh();
    let a = account(&f, json!({"name": "Current"}));
    let months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    for (i, m) in months.iter().enumerate() {
        pay(&f, a, &format!("{m}-05"), if i == 5 { -1599 } else { -1399 }, "Netflix", None);
        pay(&f, a, &format!("{m}-01"), -95_000, "Landlord", None);
        pay(&f, a, &format!("{m}-25"), 250_000, "Employer", None);
    }
    for m in &months[..4] {
        pay(&f, a, &format!("{m}-15"), -12_000, "Engie", None);
    }
    pay(&f, a, "2025-11-02", -45_000, "Insurer", None);
    pay(&f, a, "2026-11-02", -46_000, "Insurer", None);
    pay(&f, a, "2026-06-03", -2000, "Bakery", None);
    pay(&f, a, "2026-09-20", -3500, "Bakery", None);
    let r = find_recurring(&f.core, TODAY).unwrap();
    let by = |name: &str| r.items.iter().find(|i| i.name == name).unwrap();
    let mut found: Vec<&str> = r.items.iter().map(|i| i.name.as_str()).collect();
    found.sort_unstable();
    assert_eq!(found, ["Employer", "Engie", "Insurer", "Landlord", "Netflix"]);
    let n = by("Netflix");
    assert_eq!(
        (n.frequency, n.next_date.as_str(), n.status, n.price_change_cents, n.typical_cents),
        ("monthly", "2026-11-05", "due", Some(-200), -1599)
    );
    assert_eq!(by("Landlord").status, "late");
    let e = by("Employer");
    assert_eq!((e.direction, e.next_date.as_str(), e.status), ("in", "2026-11-25", "due"));
    let i = by("Insurer");
    assert_eq!((i.frequency, i.status, i.monthly_cents), ("yearly", "paid", -3833));
    assert_eq!(r.due_this_month_cents, 1599 + 95_000 + 12_000);
    assert_eq!(by("Engie").status, "late");
    assert_eq!(r.monthly_out_cents, 95_000 + 1599 + 12_000 + 3833);
}

#[test]
fn transfers_are_found_surest_first_paired_and_separated() {
    let f = fresh();
    let current = account(&f, json!({"name": "Current", "iban": "BE68539007547034"}));
    let savings = account(&f, json!({"name": "Savings", "iban": "BE71096123456769"}));
    let out1 = pay(&f, current, "2026-10-01", -50_000, "x", None);
    f.sql("UPDATE transactions SET counterparty_iban = 'BE71096123456769' WHERE id = 1");
    let in1 = pay(&f, savings, "2026-10-02", 50_000, "x", None);
    let out2 = pay(&f, current, "2026-10-10", -2000, "x", None);
    let in2 = pay(&f, savings, "2026-10-12", 2000, "x", None);
    pay(&f, current, "2026-10-20", -700, "x", None);
    pay(&f, savings, "2026-10-30", 700, "x", None);
    let found = find_transfers(f.core.db().unwrap()).unwrap();
    assert_eq!(found.iter().map(|p| (p.out_id, p.in_id, p.confidence)).collect::<Vec<_>>(), [(out1, in1, "iban"), (out2, in2, "amount")]);
    let before = f.ok("summary.month", json!({"month": "2026-10"}));
    let pairs: Vec<Value> = found.iter().map(|p| json!({"outId": p.out_id, "inId": p.in_id})).collect();
    assert_eq!(f.ok("transfers.pair", json!({ "pairs": pairs }))["paired"], 2);
    let after = f.ok("summary.month", json!({"month": "2026-10"}));
    assert_eq!(before["spendingCents"].as_i64().unwrap() - after["spendingCents"].as_i64().unwrap(), 52_000);
    assert_eq!(before["incomeCents"].as_i64().unwrap() - after["incomeCents"].as_i64().unwrap(), 52_000);
    let list = f.ok("transactions.list", json!({"limit": 10}));
    assert_eq!(list["items"].as_array().unwrap().iter().find(|t| t["id"] == out1).unwrap()["transferAccount"], "Savings");
    assert!(find_transfers(f.core.db().unwrap()).unwrap().is_empty());
    f.ok("transfers.unpair", json!({"id": in2}));
    let list = f.ok("transactions.list", json!({"limit": 10}));
    assert!(list["items"].as_array().unwrap().iter().find(|t| t["id"] == out2).unwrap()["transferAccount"].is_null());
}

#[test]
fn pairing_keeps_a_transfer_category_one_half_already_has() {
    let f = fresh();
    let (a, b) = (account(&f, json!({"name": "A"})), account(&f, json!({"name": "B"})));
    let savings = category(&f, "Savings");
    let o = pay(&f, a, "2026-10-01", -100, "x", Some(savings));
    let i = pay(&f, b, "2026-10-01", 100, "y", None);
    f.ok("transfers.pair", json!({"pairs": [{"outId": o, "inId": i}]}));
    let cats: Vec<kb_db::Cell> = f.rows("transactions").iter().map(|r| r[10].clone()).collect();
    assert_eq!(cats, [kb_db::Cell::Int(savings), kb_db::Cell::Int(savings)]);
}

fn two_currencies(pct: Option<f64>) -> (Fixture, i64, i64) {
    let f = fresh();
    let eur = account(&f, json!({"name": "Euro", "iban": "BE68539007547034", "fxCostPct": pct}));
    let usd = account(&f, json!({"name": "Dollar", "iban": "BE71096123456769", "currency": "USD"}));
    f.ok("fx.setRate", json!({"currency": "USD", "date": "2026-10-01", "perEur": 1.08}));
    (f, eur, usd)
}

#[test]
fn a_euro_out_and_dollars_in_pair_with_the_exchange_cost_booked_as_a_fee() {
    let (f, eur, usd) = two_currencies(None);
    let o = f.tx(eur, "2026-10-01", -10_000, "x");
    let i = f.tx(usd, "2026-10-02", 10_500, "y");
    let found = find_transfers(f.core.db().unwrap()).unwrap();
    let p = &found[0];
    // $108 at the day's rate, $105 arrived: $3 is about 2.78 euro lost.
    assert_eq!(
        (p.out_id, p.in_id, p.amount_cents, p.currency.as_str(), p.in_amount_cents, p.in_currency.as_str(), p.cost_cents, p.confidence),
        (o, i, 10_000, "EUR", 10_500, "USD", Some(278), "amount")
    );
    let before = f.ok("summary.month", json!({"month": "2026-10"}));
    f.ok("transfers.pair", json!({"pairs": [{"outId": o, "inId": i}]}));
    let after = f.ok("summary.month", json!({"month": "2026-10"}));
    assert_eq!(after["incomeCents"].as_i64().unwrap(), before["incomeCents"].as_i64().unwrap() - 9722);
    assert_eq!(after["spendingCents"].as_i64().unwrap(), before["spendingCents"].as_i64().unwrap() - 10_000 + 278);
    assert_eq!(f.ok("transfers.cost", json!({"id": i})), json!({"cross": true, "currency": "EUR", "costCents": 278}));
    assert_eq!(f.ok("transfers.setCost", json!({"id": o, "costCents": 250}))["costCents"], 250);
    assert_eq!(f.ok("transfers.cost", json!({"id": o}))["costCents"], 250);
    f.ok("transfers.unpair", json!({"id": o}));
    assert!(f.rows("transaction_splits").is_empty());
}

#[test]
fn amounts_too_far_apart_do_not_pair_and_the_banks_cost_decides_between_candidates() {
    let (f, eur, usd) = two_currencies(None);
    f.tx(eur, "2026-10-01", -10_000, "x");
    f.tx(usd, "2026-10-01", 9000, "y");
    assert!(find_transfers(f.core.db().unwrap()).unwrap().is_empty());
    let (g, eur, usd) = two_currencies(Some(2.0));
    g.tx(eur, "2026-10-01", -10_000, "x");
    let i = g.tx(usd, "2026-10-01", 10_584, "y");
    g.tx(usd, "2026-10-01", 10_790, "z");
    assert_eq!(find_transfers(g.core.db().unwrap()).unwrap().iter().map(|p| p.in_id).collect::<Vec<_>>(), [i]);
}

#[test]
fn without_a_rate_only_the_account_number_pairs_and_the_banks_percentage_gives_the_cost() {
    let f = fresh();
    let eur = account(&f, json!({"name": "Euro", "iban": "BE68539007547034", "fxCostPct": 1.5}));
    let chf = account(&f, json!({"name": "Franc", "iban": "CH9300762011623852957", "currency": "CHF"}));
    f.tx(eur, "2026-10-01", -20_000, "x");
    f.tx(chf, "2026-10-01", 18_500, "y");
    assert!(find_transfers(f.core.db().unwrap()).unwrap().is_empty());
    let o = f.tx(eur, "2026-10-05", -20_000, "z");
    f.sql(&format!("UPDATE transactions SET counterparty_iban = 'CH9300762011623852957' WHERE id = {o}"));
    f.tx(chf, "2026-10-05", 18_500, "w");
    let found = find_transfers(f.core.db().unwrap()).unwrap();
    assert_eq!((found[0].out_id, found[0].confidence, found[0].cost_cents), (o, "iban", Some(300)));
}

#[test]
fn the_review_compares_with_three_months_budgets_over_and_payments_that_stand_out() {
    let f = fresh();
    let a = account(&f, json!({"name": "Current"}));
    let groceries = category(&f, "Groceries");
    for m in ["2026-07", "2026-08", "2026-09"] {
        pay(&f, a, &format!("{m}-03"), -30_000, "Delhaize", Some(groceries));
        pay(&f, a, &format!("{m}-10"), -1500, "Garage", None);
    }
    pay(&f, a, "2026-10-03", -45_000, "Delhaize", Some(groceries));
    pay(&f, a, "2026-10-10", -9000, "Garage", None);
    pay(&f, a, "2026-10-20", -60_000, "New laptop shop", None);
    f.ok("budgets.set", json!({"categoryId": groceries, "month": "2026-10", "amountCents": 40_000}));
    let r = to_value(month_review(f.core.db().unwrap(), "2026-10").unwrap()).unwrap();
    assert_eq!(r["averageSpendingCents"], 31_500);
    let g = r["categories"].as_array().unwrap().iter().find(|c| c["name"] == "Groceries").unwrap();
    assert_eq!((g["cents"].clone(), g["averageCents"].clone(), g["changeCents"].clone()), (json!(45_000), json!(30_000), json!(15_000)));
    assert_eq!(r["overBudget"], json!([{"categoryId": groceries, "name": "Groceries", "budgetCents": 40_000, "spentCents": 45_000}]));
    let unusual: Vec<Value> = r["unusual"].as_array().unwrap().iter().map(|u| json!([u["name"], u["reason"]])).collect();
    assert_eq!(unusual, [json!(["New laptop shop", "new"]), json!(["Garage", "higher"])]);
}

#[test]
fn warns_about_budgets_at_80_and_100_percent_and_a_balance_below_zero_before_payday() {
    let f = fresh();
    let a = account(&f, json!({"name": "Current"}));
    f.ok("budgets.set", json!({"categoryId": category(&f, "Groceries"), "month": "2026-11", "amountCents": 10_000}));
    f.ok("budgets.set", json!({"categoryId": category(&f, "Eating out"), "month": "2026-11", "amountCents": 5000}));
    pay(&f, a, "2026-11-03", -8500, "x", Some(category(&f, "Groceries")));
    pay(&f, a, "2026-11-04", -6000, "y", Some(category(&f, "Eating out")));
    for m in ["2026-07", "2026-08", "2026-09", "2026-10"] {
        pay(&f, a, &format!("{m}-25"), 200_000, "Employer", None);
        pay(&f, a, &format!("{m}-20"), -90_000, "Landlord", None);
    }
    f.ok("balances.set", json!({"accountId": a, "date": "2026-11-10", "balanceCents": 50_000}));
    let mut alerts = list_alerts(&f.core, "2026-11-10").unwrap();
    alerts.iter_mut().for_each(kb_core::numbers::normalize);
    let budget: Vec<(String, String)> = alerts
        .iter()
        .filter(|x| x["kind"] == "budget")
        .map(|x| (x["name"].as_str().unwrap().to_owned(), x["level"].as_str().unwrap().to_owned()))
        .collect();
    assert_eq!(budget, [("Groceries".to_owned(), "near".to_owned()), ("Eating out".to_owned(), "over".to_owned())]);
    let bal = alerts.iter().find(|x| x["kind"] == "balance").unwrap();
    assert_eq!(
        (bal["until"].clone(), bal["balanceCents"].clone(), bal["dueCents"].clone(), bal["lowestCents"].clone()),
        (json!("2026-11-25"), json!(50_000), json!(90_000), json!(-40_000))
    );
}

#[test]
fn goals_track_an_account_or_an_amount_by_hand_and_say_what_to_put_aside_per_month() {
    let f = fresh();
    let savings = account(&f, json!({"name": "Savings"}));
    f.tx(savings, "2026-10-01", 50_000, "x");
    f.ok("goals.create", json!({"name": "Holiday", "targetCents": 200_000, "targetDate": "2027-05-15", "accountId": savings}));
    f.ok("goals.create", json!({"name": "Buffer", "targetCents": 100_000, "savedCents": 100_000}));
    let goals = |today: &str| to_value(list_goals(f.core.db().unwrap(), today).unwrap()).unwrap();
    let [holiday, buffer] = goals("2026-11-15").as_array().unwrap().clone().try_into().unwrap();
    assert_eq!(
        (
            holiday["currentCents"].clone(),
            holiday["remainingCents"].clone(),
            holiday["perMonthCents"].clone(),
            holiday["accountName"].clone()
        ),
        (json!(50_000), json!(150_000), json!(25_000), json!("Savings"))
    );
    assert_eq!((buffer["reached"].clone(), buffer["perMonthCents"].clone()), (json!(true), Value::Null));
    f.ok("goals.update", json!({"id": holiday["id"], "accountId": null, "savedCents": 10_000}));
    let now = goals("2026-11-15");
    assert_eq!((now[0]["currentCents"].clone(), now[0]["accountId"].clone()), (json!(10_000), Value::Null));
    let later = goals("2027-06-01");
    assert_eq!((later[0]["overdue"].clone(), later[0]["perMonthCents"].clone()), (json!(true), Value::Null));
}
