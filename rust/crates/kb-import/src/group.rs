//! `groupKey` of src/core/assist-plan.ts: which payments belong to one payee. Used by the recurring payments, the review of
//! unusual payments, and to find the readable names an earlier import gave to the same bank text.
use crate::jsstr::{collapse_spaces, is_js_space, is_letter, js_trim, slice_units};
use regex::Regex;
use std::sync::LazyLock;

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

static STRUCTURED_MESSAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\+{3}|^\*{3}|^[0-9]{3}/[0-9]{4}/[0-9]{5}$").expect("structured message regex"));

/// `in:` or `out:` and the payee: the counterparty (or the description when there is none) once numbers, dates and references
/// are taken out. Between people (a counterparty account and a free message) the message is part of the key, so each
/// message is its own group; structured communications (bills) are left out.
pub fn group_key(
    counterparty_name: Option<&str>,
    description: &str,
    amount_cents: Option<i64>,
    communication: Option<&str>,
    counterparty_iban: Option<&str>,
) -> String {
    let named = counterparty_name.map(js_trim).filter(|n| !n.is_empty());
    let text = norm(named.unwrap_or(description));
    let text = slice_units(&text, 60);
    let message = match (counterparty_iban, communication) {
        (Some(iban), Some(comm)) if !iban.is_empty() && !comm.is_empty() && !STRUCTURED_MESSAGE.is_match(js_trim(comm)) => {
            slice_units(&norm(comm), 40).to_owned()
        }
        _ => String::new(),
    };
    let sign = if amount_cents.unwrap_or(0) < 0 { "out" } else { "in" };
    if message.is_empty() {
        format!("{sign}:{text}")
    } else {
        format!("{sign}:{text}|{message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_references_do_not_split_a_payee() {
        let a = group_key(None, "Bancontact DELHAIZE LEUVEN 03/10 12:34", Some(-500), None, None);
        assert_eq!(a, group_key(None, "Bancontact DELHAIZE LEUVEN 17/10 18:02", Some(-900), None, None));
        assert_eq!(a, "out:bancontact delhaize leuven");
        assert_eq!(group_key(Some("  Café Zürich 12 "), "x", Some(50), None, None), "in:café zürich");
        assert_eq!(group_key(Some("  "), "Rent & more #4", Some(-1), None, None), "out:rent & more");
        assert_eq!(group_key(Some("a"), "", Some(0), None, None), "in:a");
        assert_eq!(group_key(Some("a"), "", None, None, None), "in:a");
    }

    #[test]
    fn a_free_message_between_people_is_its_own_group() {
        let a = group_key(Some("Anna"), "x", Some(-500), Some("Netflix share"), Some("BE68539007547034"));
        assert_eq!(a, "out:anna|netflix share");
        assert_eq!(group_key(Some("Anna"), "x", Some(-500), Some("Netflix share"), None), "out:anna");
        assert_eq!(group_key(Some("Anna"), "x", Some(-500), Some("+++090/9337/55493+++"), Some("BE68539007547034")), "out:anna");
        assert_eq!(group_key(Some("Anna"), "x", Some(-500), Some("090/9337/55493"), Some("BE68539007547034")), "out:anna");
        assert_eq!(group_key(Some("Anna"), "x", Some(-500), Some("12 34"), Some("BE68539007547034")), "out:anna");
    }
}
