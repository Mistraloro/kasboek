//! `groupKey` of src/core/assist-plan.ts for the callers that only have a counterparty, a description and an amount
//! (recurring payments, the review of unusual payments). The key itself is in `kb-import`, which imports use too.

/// `in:` or `out:` and the payee: the counterparty (or the description when there is none) once numbers, dates and
/// references are taken out.
pub fn group_key(counterparty_name: Option<&str>, description: &str, amount_cents: i64) -> String {
    kb_import::group::group_key(counterparty_name, description, Some(amount_cents), None, None)
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
