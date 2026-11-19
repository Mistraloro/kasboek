//! `groupKey` of src/core/assist-plan.ts: which payments belong to one payee (recurring payments, the review of unusual
//! payments). The message part for transfers between people is left out: only imports use it.
use crate::jsstr::{collapse_spaces, is_js_space, is_letter, js_trim, slice_units};

/// The payee's name as people read it, without numbers, dates and references: lower case, only letters, `&` and single
/// spaces.
fn norm(s: &str) -> String {
    let lower = s.to_lowercase();
    // `/[0-9][0-9/.:,\-]*/g` becomes one space.
    let mut digits_out = String::with_capacity(lower.len());
    let mut chars = lower.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            while chars.next_if(|n| n.is_ascii_digit() || matches!(n, '/' | '.' | ':' | ',' | '-')).is_some() {}
            digits_out.push(' ');
        } else {
            digits_out.push(c);
        }
    }
    // `/[^\p{L}\s&]/gu` becomes a space.
    let letters: String = digits_out.chars().map(|c| if is_letter(c) || is_js_space(c) || c == '&' { c } else { ' ' }).collect();
    js_trim(&collapse_spaces(&letters)).to_owned()
}

/// `in:` or `out:` and the payee: the counterparty (or the description when there is none) once numbers, dates and
/// references are taken out.
pub fn group_key(counterparty_name: Option<&str>, description: &str, amount_cents: i64) -> String {
    let named = counterparty_name.map(js_trim).filter(|n| !n.is_empty());
    let text = norm(named.unwrap_or(description));
    format!("{}:{}", if amount_cents < 0 { "out" } else { "in" }, slice_units(&text, 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_references_do_not_split_a_payee() {
        let a = group_key(None, "Bancontact DELHAIZE LEUVEN 03/10 12:34", -500);
        assert_eq!(a, group_key(None, "Bancontact DELHAIZE LEUVEN 17/10 18:02", -900));
        assert_eq!(a, "out:bancontact delhaize leuven");
        assert_eq!(group_key(Some("  Café Zürich 12 "), "x", 50), "in:café zürich");
        assert_eq!(group_key(Some("  "), "Rent & more #4", -1), "out:rent & more");
        assert_eq!(group_key(Some("a"), "", 0), "in:a");
    }
}
