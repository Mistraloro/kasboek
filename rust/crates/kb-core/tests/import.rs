//! The import operations, without TypeScript: the privacy rule for the assistant (nothing from above the header row found on
//! opening), the lock, and the order of the checks. The differential scenarios are in rust/parity/import.spec.ts. Invented data.
use kb_core::Actor;
use serde_json::{json, Value};

mod common;

fn b64(text: &str) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in text.as_bytes().chunks(3) {
        let n = chunk.iter().enumerate().fold(0_u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            out.push(if i <= chunk.len() { A[((n >> (18 - 6 * i)) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

const FILE: &str =
    "Account;BE68 5390 0754 7034\nHolder;Jan Janssens\nDatum;Omschrijving;Bedrag\n01/03/2026;Brood;-4,50\n02/03/2026;Loon;2.000,00\n";

fn open(f: &common::Fixture) -> Value {
    f.ok("accounts.create", json!({"name": "Main", "bank": "Invented"}));
    f.ok("import.analyze", json!({"fileName": "a.csv", "contentBase64": b64(FILE), "accountId": 1}))
}

#[test]
fn the_assistant_never_sees_the_lines_above_the_header() {
    let f = common::fresh();
    let p = open(&f);
    assert_eq!(p["mapping"]["headerRow"], 2);
    // The person moves the header up to row 0; the assistant then gets no rows and no header names from above row 2.
    let mapping = json!({"delimiter": ";", "headerRow": 0, "dateOrder": "DMY", "decimal": ",", "columns": {"bookingDate": 0, "amount": 1, "description": [0]}});
    let user = f.ok("import.remap", json!({ "mapping": mapping }));
    assert_eq!(user["headers"], json!(["Account", "BE68 5390 0754 7034"]));
    let as_assistant = |op: &str, input: Value| f.core.dispatch(op, input, Actor::Assistant);
    let seen = as_assistant("import.current", json!({})).unwrap();
    assert_eq!(seen["headers"], json!([]));
    assert_eq!(seen["sample"], json!([]));
    assert!(seen["rows"].as_array().unwrap().iter().all(|r| r["index"].as_u64().unwrap() >= 2));
    let raw = as_assistant("import.raw", json!({})).unwrap();
    assert_eq!(raw["header"], json!([]));
    assert!(raw.get("preamble").is_none());
    assert_eq!(raw["preambleLines"], 0);
    assert!(raw["rows"].as_array().unwrap().iter().all(|r| r["index"].as_u64().unwrap() >= 2));
    // The assistant cannot move the header above the one found on opening.
    let err = as_assistant("import.remap", json!({ "mapping": mapping })).unwrap_err();
    assert_eq!(err.code, "import.header_above");
    let low = json!({"delimiter": ";", "headerRow": 2, "dateOrder": "DMY", "decimal": ",", "columns": {"bookingDate": 0, "amount": 2, "description": [1]}});
    assert_eq!(as_assistant("import.remap", json!({ "mapping": low })).unwrap()["mappingSource"], "assistant");
    // The person still sees everything.
    assert_eq!(f.ok("import.raw", json!({}))["preamble"].as_array().unwrap().len(), 2);
}

#[test]
fn a_locked_core_forgets_the_open_import() {
    let mut f = common::fresh();
    open(&f);
    assert_eq!(f.ok("import.current", json!({}))["fileKind"], "csv");
    f.core.set_unlocked(false);
    assert_eq!(f.code("import.current", json!({})), "auth.locked");
    f.core.set_unlocked(true);
    assert_eq!(f.ok("import.current", json!({})), Value::Null);
}

#[test]
fn inputs_are_checked_before_the_session_is_looked_up() {
    let f = common::fresh();
    assert_eq!(f.code("import.preview", json!({"sessionId": "nope"})), "op.invalid_input");
    assert_eq!(f.code("import.preview", json!({"sessionId": "2f6c1e0a-5b8d-4c1e-9a7f-0123456789ab"})), "import.expired");
    assert_eq!(f.code("import.commit", json!({})), "import.none");
}
