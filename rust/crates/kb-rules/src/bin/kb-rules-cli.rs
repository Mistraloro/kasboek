//! Dev-only driver of the parity suite (rust/parity/mask.spec.ts); built with `--features parity`, never shipped.
//!
//! Stdin is a JSON array of `{"text": string, "max": number | null}`; stdout is one object per input with what each masking
//! function makes of the text: `iban`, `numbers`, `contacts`, `private` (cut at `max` when given) and `cut` (when `max` is given).
use kb_rules::iban::mask_iban;
use kb_rules::mask::{cut_text, mask_contacts, mask_numbers, mask_private};
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let cases: Vec<Value> = serde_json::from_str(&input).expect("a JSON array");
    let out: Vec<Value> = cases
        .iter()
        .map(|case| {
            let text = case["text"].as_str().expect("text");
            let max = case["max"].as_u64().map(|m| m as usize);
            json!({
                "iban": mask_iban(text),
                "numbers": mask_numbers(text),
                "contacts": mask_contacts(text),
                "private": mask_private(text, max),
                "cut": max.map(|m| cut_text(text, m)),
            })
        })
        .collect();
    println!("{}", Value::Array(out));
}
