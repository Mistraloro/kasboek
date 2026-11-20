//! The logic port against the answers of the TypeScript (tests/fixtures/logic.json, written by rust/parity/pdf.spec.ts): pdf.js's text of
//! 21 invented statements, and what `toLines`, `readStatement` and the assistant text selection make of it. Lines, cells, statements and
//! the text sent must be equal, number for number.
use kb_pdf::*;
use serde_json::{json, Value};

/// JSON written by JavaScript has `780` where serde writes `780.0`: every number is compared as a float.
fn same(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(same).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), same(v))).collect()),
        other => other.clone(),
    }
}

fn fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/logic.json")).unwrap()
}

fn send_json(lines: &[PdfLine]) -> Value {
    match preview_text(lines) {
        Ok(p) => {
            let parts: Vec<String> = split_parts(&lines_to_send(lines)).iter().map(part_text).collect();
            json!({ "preview": p, "parts": parts })
        }
        Err(e) => json!({ "error": { "code": e.code, "message": e.message } }),
    }
}

#[test]
fn lines_statements_and_the_text_for_the_assistant_equal_the_typescript() {
    let all = fixtures();
    assert!(all.len() >= 20);
    for case in &all {
        let name = case["name"].as_str().unwrap();
        let text: PdfText = serde_json::from_value(case["text"].clone()).unwrap();
        let own = case["own"].as_str();
        let lines = to_lines(&text);
        assert_eq!(same(&serde_json::to_value(&lines).unwrap()), same(&case["lines"]), "{name}: lines");
        let statement = read_statement(&lines, own);
        assert_eq!(same(&serde_json::to_value(&statement).unwrap()), same(&case["statement"]), "{name}: statement");
        assert_eq!(same(&send_json(&lines)), same(&case["send"]), "{name}: text for the assistant");
    }
}

#[test]
fn the_fixtures_cover_tables_blocks_and_no_table() {
    let all = fixtures();
    let kinds = |f: &dyn Fn(&Value) -> bool| all.iter().filter(|c| f(&c["statement"])).count();
    assert!(kinds(&|s| s["grid"].as_array().is_some_and(|g| g.len() > 1)) >= 15);
    assert!(kinds(&|s| s["grid"].as_array().is_some_and(|g| g.is_empty())) >= 1);
    assert!(kinds(&|s| s["balances"]["opening"].is_number() && s["balances"]["closing"].is_number()) >= 4);
    assert!(kinds(&|s| s["notes"].as_array().is_some_and(|n| n.iter().any(|x| x["code"] == "other_account"))) >= 1);
    assert!(kinds(&|s| s["notes"].as_array().is_some_and(|n| n.iter().any(|x| x["code"] == "dates_without_year"))) >= 1);
}

#[test]
fn analysis_has_the_import_input() {
    let case = fixtures().into_iter().find(|c| c["name"] == "ts_statement").unwrap();
    let text: PdfText = serde_json::from_value(case["text"].clone()).unwrap();
    let a = analyze_pdf(&text, case["own"].as_str());
    assert_eq!(same(&serde_json::to_value(&a.grid).unwrap()), same(&case["statement"]["grid"]));
    assert_eq!(a.pdf.pages, 3);
    assert_eq!(a.pdf.read_by, ReadBy::Kasboek);
    assert_eq!(same(&serde_json::to_value(&a.pdf.balances).unwrap()), same(&case["statement"]["balances"]));
    assert!(a.pdf.notes.is_empty());
    // no table: counts only, as open.ts writes them
    let letter = fixtures().into_iter().find(|c| c["name"] == "free_text_no_table").unwrap();
    let text: PdfText = serde_json::from_value(letter["text"].clone()).unwrap();
    let a = analyze_pdf(&text, None);
    assert!(a.grid.is_empty());
    assert_eq!(a.pdf.notes, vec![PdfNote::NoTable { pages: 1, lines: a.pdf.lines.len() }]);
}
