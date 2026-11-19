//! The two helpers migration 8 needs from the TypeScript core: `fingerprint` (src/core/fingerprint.ts) and
//! `realReference` (src/core/csv/normalize.ts). Migrations may not change once shipped, so these stay as they were.
use sha2::{Digest, Sha256};

/// The characters of JavaScript's `\s`.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Lower-case, runs of whitespace to one space, trimmed.
fn norm(text: Option<&str>) -> String {
    let lower = text.unwrap_or("").to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut pending_space = false;
    for c in lower.chars() {
        if is_js_space(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

pub(crate) struct FingerprintInput<'a> {
    pub account_id: i64,
    pub booking_date: &'a str,
    pub amount_cents: i64,
    pub counterparty_name: Option<&'a str>,
    pub description: Option<&'a str>,
    pub bank_reference: Option<&'a str>,
}

pub(crate) fn fingerprint(t: &FingerprintInput<'_>) -> String {
    let joined = format!(
        "{}|{}|{}|{}|{}|{}",
        t.account_id,
        t.booking_date,
        t.amount_cents,
        norm(t.counterparty_name),
        norm(t.description),
        norm(t.bank_reference)
    );
    hex::encode(&Sha256::digest(joined.as_bytes())[..16])
}

/// A bank reference only when it identifies the transaction: not empty, not only `-0 ./` and spaces, not only a year.
pub(crate) fn real_reference(text: Option<&str>) -> Option<&str> {
    let s = text.unwrap_or("").trim_matches(|c: char| is_js_space(c));
    if s.chars().all(|c| matches!(c, '-' | '0' | '.' | '/') || is_js_space(c)) {
        return None;
    }
    let bytes = s.as_bytes();
    let year = bytes.len() >= 4 && matches!(&bytes[..2], b"19" | b"20") && bytes[2].is_ascii_digit() && bytes[3].is_ascii_digit();
    let rest = bytes.get(4..).unwrap_or(&[]);
    if year && (rest.is_empty() || (rest.len() == 1 && matches!(rest[0], b'-' | b'/' | b'.'))) {
        return None;
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_not_references() {
        for none in ["", "  ", "-", "0000", "- / .", "2026-", "2026", "1999/", "2026."] {
            assert_eq!(real_reference(Some(none)), None, "{none:?}");
        }
        assert_eq!(real_reference(None), None);
        for some in ["2026-0001", "20267", "12345", " AB1 ", "2026-x"] {
            assert_eq!(real_reference(Some(some)), Some(some.trim()), "{some:?}");
        }
    }

    #[test]
    fn fingerprint_normalises_text_like_the_app() {
        let base = FingerprintInput {
            account_id: 1,
            booking_date: "2025-03-04",
            amount_cents: -1250,
            counterparty_name: Some("  Shop\u{a0}  ONE "),
            description: Some("Invented\tpayment"),
            bank_reference: None,
        };
        let same = FingerprintInput { counterparty_name: Some("shop one"), description: Some("invented payment"), ..base };
        assert_eq!(fingerprint(&base), fingerprint(&same));
        assert_eq!(fingerprint(&base).len(), 32);
    }
}
