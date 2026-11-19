//! Plain rows and filters of the typed queries in [`crate::Queries`]. Engine-neutral: no SQL types leak out of `kb-db`.

#[derive(Debug, Clone, PartialEq)]
pub struct AccountRow {
    pub id: i64,
    pub name: String,
    pub bank: String,
    pub iban: Option<String>,
    pub currency: String,
    pub kind: String,
    pub opening_balance_cents: i64,
    pub archived: bool,
    pub created_at: String,
    pub fx_cost_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewAccount {
    pub name: String,
    pub bank: String,
    pub iban: Option<String>,
    pub currency: String,
    pub kind: String,
    pub opening_balance_cents: i64,
    pub fx_cost_pct: Option<f64>,
}

/// An account with the sum of its transactions in its own currency (`bal` already includes the opening balance).
#[derive(Debug, Clone, PartialEq)]
pub struct BalanceRow {
    pub id: i64,
    pub currency: String,
    pub bal: f64,
    pub count: i64,
    /// The account has recorded bank balances or values.
    pub checked: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CategoryRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub parent_id: Option<i64>,
    pub color: Option<String>,
    pub sort_order: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckpointRow {
    pub date: String,
    pub value: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValuationRow {
    pub account_id: i64,
    pub date: String,
    pub value_cents: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TxRow {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CategoryFilter {
    /// Only uncategorised transactions.
    None,
    Id(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

/// The WHERE part of a transactions listing. `month` is the half-open range `[from, to)` of the month filter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TxFilterRow {
    pub account_id: Option<i64>,
    pub category: Option<CategoryFilter>,
    pub month: Option<(String, String)>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub direction: Option<Direction>,
    /// Already trimmed; searched in the readable texts and the bank's own, wildcards escaped by the query.
    pub search: Option<String>,
}

/// Count and totals of a whole filter, in the main currency (`fx()`; amounts without a rate are left out).
#[derive(Debug, Clone, PartialEq)]
pub struct TxTotals {
    pub count: i64,
    pub income: f64,
    pub outgoing: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewTxRow {
    pub account_id: i64,
    pub booking_date: String,
    pub value_date: Option<String>,
    pub amount_cents: i64,
    pub currency: String,
    pub description: String,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub communication: Option<String>,
    pub category_id: Option<i64>,
    pub notes: Option<String>,
    pub import_batch_id: Option<i64>,
    pub bank_reference: Option<String>,
    pub fingerprint: String,
    pub bank_counterparty: Option<String>,
    pub bank_description: String,
}

/// The editable columns of a transaction, all set (the caller merges the change with the current row).
#[derive(Debug, Clone, PartialEq)]
pub struct TxEdit {
    pub category_id: Option<i64>,
    pub notes: Option<String>,
    pub description: String,
    pub booking_date: String,
    pub amount_cents: i64,
    pub counterparty_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SplitRow {
    pub category_id: Option<i64>,
    pub amount_cents: i64,
    pub note: Option<String>,
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewSplit {
    pub category_id: Option<i64>,
    pub amount_cents: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleRow {
    pub id: i64,
    pub field: String,
    pub match_kind: String,
    pub pattern: String,
    pub category_id: i64,
    pub category_name: String,
    pub priority: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FxRateRow {
    pub currency: String,
    pub date: String,
    pub per_eur: f64,
    pub source: String,
}

/// What `fx.status` needs per currency.
#[derive(Debug, Clone, PartialEq)]
pub struct FxCurrencyFacts {
    pub currency: String,
    pub latest: Option<FxRateRow>,
    pub ecb_rates: i64,
    pub manual_rates: i64,
    pub oldest_tx: Option<String>,
    pub first_rate: Option<String>,
}

/// What an imported settings reset would find (see `resetImportedSettings` in src/core/settings.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportResetFacts {
    pub ai_key: bool,
    pub ai_endpoint: bool,
    pub permissions: bool,
    pub mcp: bool,
    pub auto_backup: bool,
    pub memory: bool,
    pub sync: bool,
}
