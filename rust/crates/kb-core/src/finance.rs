//! Transactions, categories and the rule matching a new transaction goes through: the parts of src/core/finance.ts
//! the ported operations use. All SQL is behind [`kb_db::Queries`].
use crate::error::{AppError, AppResult};
use crate::jsstr::{collapse_spaces, is_js_space, js_trim};
use kb_db::rows::{CategoryFilter, Direction, NewSplit, NewTxRow, RuleRow, TxEdit, TxFilterRow, TxRow};
use kb_db::{DbError, Store};
use serde::Serialize;
use sha2::{Digest, Sha256};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/* ---------- Output shapes ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub account_name: String,
    pub booking_date: String,
    pub value_date: Option<String>,
    pub amount_cents: i64,
    pub currency: String,
    pub description: String,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub communication: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub notes: Option<String>,
    pub import_batch_id: Option<i64>,
    pub transfer_account: Option<String>,
    pub split_count: i64,
}

impl From<TxRow> for Transaction {
    fn from(r: TxRow) -> Self {
        Self {
            id: r.id,
            account_id: r.account_id,
            account_name: r.account_name,
            booking_date: r.booking_date,
            value_date: r.value_date,
            amount_cents: r.amount_cents,
            currency: r.currency,
            description: r.description,
            counterparty_name: r.counterparty_name,
            counterparty_iban: r.counterparty_iban,
            communication: r.communication,
            category_id: r.category_id,
            category_name: r.category_name,
            notes: r.notes,
            import_batch_id: r.import_batch_id,
            transfer_account: r.transfer_account,
            split_count: r.split_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPage {
    pub items: Vec<Transaction>,
    pub total: i64,
    pub in_cents: f64,
    pub out_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitLine {
    pub category_id: Option<i64>,
    pub amount_cents: i64,
    pub note: Option<String>,
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub parent_id: Option<i64>,
    pub color: Option<String>,
    pub sort_order: i64,
    pub archived: bool,
}

/* ---------- Transactions ---------- */

pub struct ListFilter {
    pub account_id: Option<i64>,
    pub category: Option<CategoryFilter>,
    /// The month as `[from, to)`.
    pub month: Option<(String, String)>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub search: Option<String>,
    pub direction: Option<Direction>,
    pub limit: i64,
    pub offset: i64,
}

/// `addMonths(month, 1)` for a valid `YYYY-MM`.
pub fn month_range(month: &str) -> (String, String) {
    let year: i64 = month[..4].parse().unwrap_or(0);
    let m: i64 = month[5..].parse().unwrap_or(1);
    // `new Date(y, m, 1)` rolls December over into January of the next year.
    let (ny, nm) = if m == 12 { (year + 1, 1) } else { (year, m + 1) };
    (format!("{month}-01"), format!("{ny:04}-{nm:02}-01"))
}

pub fn list_transactions<S: Store>(store: &S, f: &ListFilter, main_currency: &str) -> AppResult<TransactionPage> {
    let search = f.search.as_deref().map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let filter = TxFilterRow {
        account_id: f.account_id,
        category: f.category,
        month: f.month.clone(),
        from: f.from.clone(),
        to: f.to.clone(),
        direction: f.direction,
        search,
    };
    let (rows, totals) = store.tx_page(&filter, f.limit, f.offset, main_currency)?;
    Ok(TransactionPage {
        items: rows.into_iter().map(Transaction::from).collect(),
        total: totals.count,
        in_cents: totals.income,
        out_cents: -totals.outgoing,
    })
}

pub fn get_transaction<S: Store>(store: &S, id: i64) -> AppResult<Transaction> {
    store.tx_get(id)?.map(Transaction::from).ok_or_else(|| AppError::new("tx.not_found", "That transaction no longer exists."))
}

fn require_account<S: Store>(store: &S, id: i64) -> AppResult<kb_db::rows::AccountRow> {
    store.account_get(id)?.ok_or_else(|| AppError::new("accounts.not_found", "Account not found."))
}

pub fn require_category<S: Store>(store: &S, id: Option<i64>) -> AppResult<()> {
    match id {
        Some(id) if !store.category_exists(id)? => Err(AppError::new("categories.not_found", "Category not found.")),
        _ => Ok(()),
    }
}

/// What the operation `transactions.create` gives (the other fields of TypeScript's `NewTx` are for imports).
pub struct NewTx {
    pub account_id: i64,
    pub booking_date: String,
    pub amount_cents: i64,
    pub description: String,
    pub counterparty_name: Option<String>,
    pub category_id: Option<i64>,
    pub notes: Option<String>,
}

fn norm(s: Option<&str>) -> String {
    js_trim(&collapse_spaces(&s.unwrap_or("").to_lowercase())).to_owned()
}

/// Identifies "the same transaction" across imports: same account, date, amount, counterparty and description (and bank
/// reference when there is one). Not unique on purpose: two identical coffees on one day are both real.
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

/// Creates a transaction: the account and category must exist, and without a category the first matching rule gives one.
pub fn create_transaction<S: Store>(store: &S, t: &NewTx) -> AppResult<Transaction> {
    let account = require_account(store, t.account_id)?;
    require_category(store, t.category_id)?;
    let category_id = match t.category_id {
        Some(id) => Some(id),
        None => match_rule(
            &store.rules_all()?,
            &RuleText { counterparty_name: t.counterparty_name.as_deref(), description: Some(&t.description), ..RuleText::default() },
        )
        .map(|r| r.category_id),
    };
    let id = store.tx_insert(&NewTxRow {
        account_id: t.account_id,
        booking_date: t.booking_date.clone(),
        value_date: None,
        amount_cents: t.amount_cents,
        currency: account.currency,
        description: t.description.clone(),
        counterparty_name: t.counterparty_name.clone(),
        counterparty_iban: None,
        communication: None,
        category_id,
        notes: t.notes.clone(),
        import_batch_id: None,
        bank_reference: None,
        fingerprint: fingerprint(t.account_id, &t.booking_date, t.amount_cents, t.counterparty_name.as_deref(), Some(&t.description), None),
        bank_counterparty: t.counterparty_name.clone(),
        bank_description: t.description.clone(),
    })?;
    get_transaction(store, id)
}

/// A change to a transaction; `None` leaves a field as it is, `Some(None)` clears a nullable one.
pub struct TxChange {
    pub id: i64,
    pub category_id: Option<Option<i64>>,
    pub notes: Option<Option<String>>,
    pub description: Option<String>,
    pub booking_date: Option<String>,
    pub amount_cents: Option<i64>,
    pub counterparty_name: Option<Option<String>>,
}

pub fn update_transaction<S: Store>(store: &S, c: &TxChange) -> AppResult<Transaction> {
    let current = get_transaction(store, c.id)?;
    require_category(store, c.category_id.flatten())?;
    let edit = TxEdit {
        category_id: c.category_id.unwrap_or(current.category_id),
        notes: c.notes.clone().unwrap_or(current.notes),
        description: c.description.clone().unwrap_or(current.description),
        booking_date: c.booking_date.clone().unwrap_or(current.booking_date),
        amount_cents: c.amount_cents.unwrap_or(current.amount_cents),
        counterparty_name: c.counterparty_name.clone().unwrap_or(current.counterparty_name),
    };
    store.tx_update(c.id, &edit)?;
    get_transaction(store, c.id)
}

/// Sets the category of the transactions (`None` = uncategorised); returns how many rows changed.
pub fn categorize_transactions<S: Store>(store: &S, ids: &[i64], category_id: Option<i64>) -> AppResult<u64> {
    require_category(store, category_id)?;
    Ok(store.transaction::<_, DbError, _>(|s| {
        let mut updated = 0;
        for id in ids {
            updated += s.tx_set_category(*id, category_id, false)?;
        }
        Ok(updated)
    })?)
}

pub fn rename_transactions<S: Store>(store: &S, ids: &[i64], counterparty_name: &str) -> AppResult<u64> {
    Ok(store.transaction::<_, DbError, _>(|s| {
        let mut updated = 0;
        for id in ids {
            updated += s.tx_set_counterparty(*id, js_trim(counterparty_name))?;
        }
        Ok(updated)
    })?)
}

pub fn delete_transactions<S: Store>(store: &S, ids: &[i64]) -> AppResult<u64> {
    Ok(store.transaction::<_, DbError, _>(|s| {
        let mut deleted = 0;
        for id in ids {
            deleted += s.tx_delete(*id)?;
        }
        Ok(deleted)
    })?)
}

/* ---------- Splits ---------- */

pub struct SplitPart {
    pub category_id: Option<i64>,
    pub amount_cents: i64,
    pub note: Option<String>,
}

pub fn list_splits<S: Store>(store: &S, tx_id: i64) -> AppResult<Vec<SplitLine>> {
    Ok(store
        .splits_list(tx_id)?
        .into_iter()
        .map(|r| SplitLine { category_id: r.category_id, amount_cents: r.amount_cents, note: r.note, category_name: r.category_name })
        .collect())
}

/// Splits a transaction over categories (e.g. one receipt: groceries and household). The parts must add up to the
/// transaction's amount; summaries and budgets then count the parts. An empty list removes the split.
pub fn set_splits<S: Store>(store: &S, tx_id: i64, parts: &[SplitPart]) -> AppResult<Vec<SplitLine>> {
    let amount = store.tx_amount(tx_id)?.ok_or_else(|| AppError::new("tx.not_found", "That transaction no longer exists."))?;
    if parts.len() == 1 {
        return Err(AppError::new("splits.one", "A split needs at least two parts."));
    }
    if parts.iter().any(|p| p.amount_cents == 0) {
        return Err(AppError::new("splits.zero", "Each part needs an amount."));
    }
    let sum: i64 = parts.iter().map(|p| p.amount_cents).sum();
    if !parts.is_empty() && sum != amount {
        return Err(AppError::new("splits.sum", "The parts must add up to the amount of the transaction."));
    }
    for p in parts {
        require_category(store, p.category_id)?;
    }
    let rows: Vec<NewSplit> = parts
        .iter()
        .map(|p| NewSplit {
            category_id: p.category_id,
            amount_cents: p.amount_cents,
            // `p.note?.trim() || null`
            note: p.note.as_deref().map(js_trim).filter(|n| !n.is_empty()).map(str::to_owned),
        })
        .collect();
    store.transaction::<_, DbError, _>(|s| s.splits_replace(tx_id, &rows))?;
    list_splits(store, tx_id)
}

/* ---------- Categories ---------- */

pub fn list_categories<S: Store>(store: &S) -> AppResult<Vec<Category>> {
    Ok(store
        .categories_all()?
        .into_iter()
        .map(|r| Category {
            id: r.id,
            name: r.name,
            kind: r.kind,
            parent_id: r.parent_id,
            color: r.color,
            sort_order: r.sort_order,
            archived: r.archived,
        })
        .collect())
}

fn category_duplicate(e: DbError) -> AppError {
    match e {
        DbError::Unique(_) => AppError::new("categories.duplicate", "A category with this name already exists."),
        other => other.into(),
    }
}

pub fn create_category<S: Store>(store: &S, name: &str, kind: &str) -> AppResult<()> {
    store.category_insert(name, kind).map(drop).map_err(category_duplicate)
}

pub fn update_category<S: Store>(store: &S, id: i64, name: Option<&str>, archived: Option<bool>) -> AppResult<()> {
    require_category(store, Some(id))?;
    if let Some(name) = name {
        store.category_set_name(id, name).map_err(category_duplicate)?;
    }
    if let Some(archived) = archived {
        store.category_set_archived(id, archived).map_err(category_duplicate)?;
    }
    Ok(())
}

/* ---------- Rules ---------- */

/// What a rule looks at: the readable text and the bank's own text (and the counterparty's IBAN).
#[derive(Default)]
pub struct RuleText<'a> {
    pub counterparty_name: Option<&'a str>,
    pub description: Option<&'a str>,
    pub bank_counterparty: Option<&'a str>,
    pub bank_description: Option<&'a str>,
    pub counterparty_iban: Option<&'a str>,
}

/// Lower case, without accents, spaces collapsed and trimmed.
fn fold(s: &str) -> String {
    let lowered = s.to_lowercase();
    let stripped: String = lowered.nfkd().filter(|c| !is_combining_mark(*c)).collect();
    js_trim(&collapse_spaces(&stripped)).to_owned()
}

/// `[\p{L}\p{N}]`, approximated by Rust's alphabetic and numeric properties.
fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

/// `(?:^|[^\p{L}\p{N}])p(?:$|[^\p{L}\p{N}])` found in `t`: `p` somewhere with no letter or digit right before or after.
fn contains_word(t: &str, p: &str) -> bool {
    t.char_indices().any(|(at, _)| {
        t[at..].starts_with(p)
            && t[..at].chars().next_back().is_none_or(|c| !is_word_char(c))
            && t[at + p.len()..].chars().next().is_none_or(|c| !is_word_char(c))
    })
}

/// Whether one text matches a rule's pattern (case- and accent-insensitive).
pub fn text_matches(text: &str, pattern: &str, match_kind: &str) -> bool {
    let t = fold(text);
    let p = fold(pattern);
    if p.is_empty() {
        return false;
    }
    match match_kind {
        "starts" => t.starts_with(&p),
        "word" => contains_word(&t, &p),
        _ => t.contains(&p),
    }
}

fn norm_iban(s: Option<&str>) -> String {
    s.unwrap_or("").chars().filter(|c| !is_js_space(*c)).collect::<String>().to_uppercase()
}

fn rule_matches(r: &RuleRow, t: &RuleText<'_>) -> bool {
    if r.field == "iban" {
        return t.counterparty_iban.is_some_and(|i| !i.is_empty()) && norm_iban(t.counterparty_iban) == norm_iban(Some(&r.pattern));
    }
    let any = |texts: [Option<&str>; 2]| texts.into_iter().flatten().any(|x| !x.is_empty() && text_matches(x, &r.pattern, &r.match_kind));
    if r.field != "description" && any([t.counterparty_name, t.bank_counterparty]) {
        return true;
    }
    r.field != "counterparty" && any([t.description, t.bank_description])
}

/// The first matching rule in rule order (priority, then counterparty rules, then the longest text).
pub fn match_rule<'r>(rules: &'r [RuleRow], t: &RuleText<'_>) -> Option<&'r RuleRow> {
    rules.iter().find(|r| rule_matches(r, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_texts_match_without_case_and_accents() {
        assert!(text_matches("CAFÉ Brugge", "cafe", "contains"));
        assert!(text_matches("Shop  ONE", "shop one", "starts"));
        assert!(!text_matches("xshop", "shop", "word"));
        assert!(text_matches("a shop.", "shop", "word"));
        assert!(text_matches("aaa a", "a", "word"));
        assert!(!text_matches("anything", "", "contains"));
        assert!(text_matches("ﬁsh", "fish", "contains"), "compatibility forms fold");
    }

    #[test]
    fn fingerprints_ignore_case_and_spacing() {
        let a = fingerprint(1, "2026-10-01", -500, Some(" Delhaize  Gent "), Some("Betaling"), None);
        let b = fingerprint(1, "2026-10-01", -500, Some("delhaize gent"), Some("BETALING"), None);
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        assert_ne!(a, fingerprint(2, "2026-10-01", -500, Some("delhaize gent"), Some("BETALING"), None));
    }

    #[test]
    fn months_roll_over() {
        assert_eq!(month_range("2026-12"), ("2026-12-01".into(), "2027-01-01".into()));
        assert_eq!(month_range("2026-02"), ("2026-02-01".into(), "2026-03-01".into()));
    }
}
