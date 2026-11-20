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

// ------------------------------------------------------------------------- commit, remap and update_rows

/// The id of the open import, also when its preview no longer works.
fn session_id(f: &common::Fixture) -> String {
    kb_core::import::latest_session(&f.core).expect("an import is open")
}

fn mapping(header_row: u64, amount: u64) -> Value {
    json!({"delimiter": ";", "headerRow": header_row, "dateOrder": "DMY", "decimal": ",", "columns": {"bookingDate": 0, "amount": amount, "description": [1]}})
}

#[test]
fn a_commit_writes_the_batch_and_closes_the_session() {
    let f = common::fresh();
    open(&f);
    let done = f.ok("import.commit", json!({}));
    assert_eq!((done["imported"].as_u64(), done["skipped"].as_u64()), (Some(2), Some(0)));
    assert_eq!(done["lastDate"], "2026-03-02");
    assert_eq!(f.ok("import.current", json!({})), Value::Null, "the session is gone");
    assert_eq!(f.ok("import.batches", json!({}))[0]["rowCount"], 2);
    assert_eq!(f.ok("transactions.list", json!({}))["total"], 2);
    assert_eq!(f.code("import.commit", json!({})), "import.none");
    // The same file again: both rows are now duplicates, so there is nothing to import.
    f.ok("import.analyze", json!({"fileName": "a.csv", "contentBase64": b64(FILE), "accountId": 1}));
    let again = f.ok("import.preview", json!({"sessionId": f.ok("import.current", json!({}))["sessionId"]}));
    assert_eq!(again["stats"]["duplicates"], 2);
    assert_eq!(f.code("import.commit", json!({})), "import.nothing");
    assert_eq!(f.ok("import.current", json!({}))["fileKind"], "csv", "a refused commit leaves the session open");
}

#[test]
fn a_commit_without_a_mapping_or_ready_rows_is_refused() {
    let f = common::fresh();
    f.ok("accounts.create", json!({"name": "Main", "bank": "Invented"}));
    f.ok("import.analyze", json!({"fileName": "n.csv", "contentBase64": b64("Foo;Bar\nx;y\nz;w\n"), "accountId": 1}));
    assert_eq!(f.code("import.commit", json!({})), "import.no_mapping");
    let g = common::fresh();
    open(&g);
    let skip = |i: u64| json!({"index": i, "decided": "skip"});
    g.ok("import.updateRows", json!({"changes": [skip(0), skip(1)]}));
    assert_eq!(g.code("import.commit", json!({})), "import.nothing");
}

#[test]
fn remap_refuses_columns_and_header_rows_that_do_not_exist() {
    let f = common::fresh();
    open(&f);
    assert_eq!(f.code("import.remap", json!({"mapping": mapping(2, 9)})), "import.bad_mapping");
    assert_eq!(f.code("import.remap", json!({"mapping": mapping(4, 2)})), "import.bad_mapping", "no row below the header");
    let no_amount = json!({"delimiter": ";", "headerRow": 2, "dateOrder": "DMY", "decimal": ",", "columns": {"bookingDate": 0}});
    assert_eq!(f.code("import.remap", json!({"mapping": no_amount})), "op.invalid_input");
    assert_eq!(
        f.code("import.remap", json!({"sessionId": "2f6c1e0a-5b8d-4c1e-9a7f-0123456789ab", "mapping": mapping(2, 2)})),
        "import.expired"
    );
    // None of the refusals changed the open import.
    assert_eq!(f.ok("import.current", json!({}))["mappingSource"], "detected");
    assert_eq!(f.ok("import.remap", json!({"mapping": mapping(2, 2)}))["mappingSource"], "manual");
}

#[test]
fn update_rows_changes_rows_and_checks_its_input() {
    let f = common::fresh();
    open(&f);
    let p = f.ok(
        "import.updateRows",
        json!({"changes": [{"index": 0, "decided": "skip", "note": "twice"}, {"index": 1, "amountCents": 250_000}]}),
    );
    assert_eq!((p["rows"][0]["status"].as_str(), p["rows"][0]["note"].as_str()), (Some("skipped"), Some("twice")));
    assert_eq!(p["rows"][1]["amountCents"], 250_000);
    assert_eq!((p["stats"]["ready"].as_u64(), p["stats"]["skipped"].as_u64(), p["edited"].as_u64()), (Some(1), Some(1), Some(2)));
    assert_eq!(f.code("import.updateRows", json!({"changes": []})), "op.invalid_input");
    assert_eq!(f.code("import.updateRows", json!({"changes": [{"index": -1}]})), "op.invalid_input");
    assert_eq!(f.code("import.updateRows", json!({"changes": [{"index": 0, "bookingDate": "03/11/2026"}]})), "op.invalid_input");
    assert_eq!(
        f.code("import.updateRows", json!({"sessionId": "2f6c1e0a-5b8d-4c1e-9a7f-0123456789ab", "changes": [{"index": 0}]})),
        "import.expired"
    );
    // As in the TypeScript core, an index past the last row is not checked: it is kept and shows nowhere.
    let past = f.ok("import.updateRows", json!({"changes": [{"index": 99, "decided": "skip"}]}));
    assert_eq!((past["rows"].as_array().unwrap().len(), past["edited"].as_u64()), (2, Some(3)));
}

#[test]
fn a_date_that_no_calendar_has_breaks_every_preview_as_in_typescript() {
    let f = common::fresh();
    open(&f);
    // zod only checks the shape of the date; the duplicate search then shifts it by days, which throws for month 13.
    assert_eq!(f.code("import.updateRows", json!({"changes": [{"index": 0, "bookingDate": "2026-13-01"}]})), "op.failed");
    assert_eq!(f.code("import.preview", json!({"sessionId": session_id(&f)})), "op.failed");
    // The way out is to correct the date.
    let fixed = f.ok("import.updateRows", json!({"changes": [{"index": 0, "bookingDate": "2026-03-01"}]}));
    assert_eq!(fixed["rows"][0]["bookingDate"], "2026-03-01");
}

#[test]
fn the_assistant_totals_count_the_visible_rows_only() {
    let f = common::fresh();
    open(&f);
    f.ok("import.remap", json!({ "mapping": json!({"delimiter": ";", "headerRow": 0, "dateOrder": "DMY", "decimal": ",", "columns": {"bookingDate": 0, "amount": 1, "description": [0]}}) }));
    let as_assistant = f.core.dispatch("import.current", json!({}), Actor::Assistant).unwrap();
    let visible = as_assistant["rows"].as_array().unwrap().len();
    assert_eq!(as_assistant["stats"]["total"], visible);
    let counted: u64 = ["ready", "duplicates", "possibleDuplicates", "problems", "skipped"]
        .iter()
        .map(|k| as_assistant["stats"][*k].as_u64().unwrap())
        .sum();
    assert_eq!(counted as usize, visible);
    let person = f.ok("import.current", json!({}));
    assert!(person["stats"]["total"].as_u64().unwrap() > as_assistant["stats"]["total"].as_u64().unwrap());
}
