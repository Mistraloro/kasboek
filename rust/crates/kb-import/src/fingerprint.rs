//! `fingerprint` of src/core/fingerprint.ts: identifies "the same transaction" across imports.
use crate::jsstr::{collapse_spaces, js_trim};
use sha2::{Digest, Sha256};

fn norm(s: Option<&str>) -> String {
    js_trim(&collapse_spaces(&s.unwrap_or("").to_lowercase())).to_owned()
}

/// Same account, date, amount, counterparty and description (and bank reference when there is one), hashed in this order.
/// Not unique on purpose: two identical coffees on one day are both real.
pub fn fingerprint(
    account_id: i64,
    booking_date: &str,
    amount_cents: i64,
    counterparty: Option<&str>,
    description: Option<&str>,
    bank_reference: Option<&str>,
) -> String {
    let text = format!("{account_id}|{booking_date}|{amount_cents}|{}|{}|{}", norm(counterparty), norm(description), norm(bank_reference));
    hex::encode(Sha256::digest(text.as_bytes()))[..32].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_ignore_case_and_spacing() {
        let a = fingerprint(1, "2026-10-01", -500, Some(" Delhaize  Gent "), Some("Betaling"), None);
        let b = fingerprint(1, "2026-10-01", -500, Some("delhaize gent"), Some("BETALING"), None);
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        assert_ne!(a, fingerprint(2, "2026-10-01", -500, Some("delhaize gent"), Some("BETALING"), None));
    }
}
