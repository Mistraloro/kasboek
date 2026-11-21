//! Known answers of the local insights from the TypeScript (rust/parity/fixtures/insights.json, written by
//! rust/parity/gen-insights-fixtures.spec.ts): `localeCompare` of random strings, `hashFacts`, `factsPayload` and the prompts.
use kb_core::insight_plan::{facts_payload, insights_system, INSIGHT_INSTRUCTIONS};
use kb_core::insights::{hash_facts, locale_compare, InsightFact, InsightValue};
use serde_json::Value;
use std::cmp::Ordering;
use std::path::PathBuf;

fn fixture() -> Value {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/fixtures/insights.json");
    serde_json::from_slice(&std::fs::read(file).expect("fixtures/insights.json")).expect("valid JSON")
}

fn sign(o: Ordering) -> i64 {
    o as i64
}

#[test]
fn locale_compare_equals_javascript_on_random_strings() {
    let f = fixture();
    let pairs = f["collation"].as_array().unwrap();
    assert!(pairs.len() > 3000);
    let mut zero = 0;
    for p in pairs {
        let (a, b) = (p["a"].as_str().unwrap(), p["b"].as_str().unwrap());
        let want = p["cmp"].as_i64().unwrap();
        zero += usize::from(want == 0);
        assert_eq!(sign(locale_compare(a, b)), want, "{a:?} against {b:?}");
    }
    assert!(zero > 0, "the fixture holds equal pairs too");
}

#[test]
fn sorting_with_locale_compare_gives_the_javascript_order() {
    let f = fixture();
    for list in f["lists"].as_array().unwrap() {
        let mut items: Vec<&str> = list["items"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        items.sort_by(|a, b| locale_compare(a, b));
        let want: Vec<&str> = list["sorted"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(items, want);
    }
}

#[test]
fn hash_facts_equals_the_typescript_hash() {
    let f = fixture();
    for h in f["hashes"].as_array().unwrap() {
        let facts = h["facts"].as_array().unwrap();
        assert_eq!(hash_facts(facts).unwrap(), h["hash"].as_str().unwrap(), "{facts:?}");
    }
}

fn kind_of(kind: &str) -> &'static str {
    ["late", "subscriptions", "balance_low", "near_budget", "unusual", "price_up"]
        .into_iter()
        .find(|k| *k == kind)
        .expect("a kind of the fixture")
}

fn fact(v: &Value) -> InsightFact {
    let values = v["values"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, x)| {
            let value = if let Some(money) = x.get("money") {
                InsightValue::Money { money: money.as_f64().unwrap(), currency: x["currency"].as_str().unwrap().to_owned() }
            } else if let Some(date) = x.get("date") {
                InsightValue::Date(date.as_str().unwrap().to_owned())
            } else if let Some(count) = x.get("count") {
                InsightValue::Count(count.as_f64().unwrap())
            } else {
                InsightValue::Text(x["text"].as_str().unwrap().to_owned())
            };
            (k.clone(), value)
        })
        .collect();
    InsightFact {
        id: v["id"].as_str().unwrap().to_owned(),
        key: v["key"].as_str().unwrap().to_owned(),
        kind: kind_of(v["kind"].as_str().unwrap()),
        values,
        category_id: None,
        recurring_key: None,
        transaction_ids: Vec::new(),
        weight: v["weight"].as_f64().unwrap(),
    }
}

#[test]
fn facts_payload_equals_the_typescript_text() {
    let f = fixture();
    for p in f["payloads"].as_array().unwrap() {
        let facts: Vec<InsightFact> = p["facts"].as_array().unwrap().iter().map(fact).collect();
        let o = &p["opts"];
        let (text, fields) =
            facts_payload(&facts, o["currency"].as_str().unwrap(), o["month"].as_str().unwrap(), o["today"].as_str().unwrap());
        assert_eq!(text, p["text"].as_str().unwrap());
        for (id, names) in p["fields"].as_object().unwrap() {
            let want: Vec<&str> = names.as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
            assert_eq!(fields[id], want, "{id}");
        }
    }
}

#[test]
fn the_prompts_equal_the_typescript_ones() {
    let f = fixture();
    assert_eq!(INSIGHT_INSTRUCTIONS, f["instructions"].as_str().unwrap());
    for (language, text) in f["systems"].as_object().unwrap() {
        assert_eq!(insights_system(language), text.as_str().unwrap(), "{language:?}");
    }
}
