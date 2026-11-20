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

/// The columns of a transaction a rule looks at.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleTextRow {
    pub id: i64,
    pub counterparty_name: Option<String>,
    pub description: String,
    pub bank_counterparty: Option<String>,
    pub bank_description: Option<String>,
    pub counterparty_iban: Option<String>,
    pub category_id: Option<i64>,
}

/// An expense category with its budget for one month.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetCategoryRow {
    pub id: i64,
    pub name: String,
    pub amount_cents: Option<i64>,
}

/// One row of the year summary: a month and category with money in and out (main currency).
#[derive(Debug, Clone, PartialEq)]
pub struct YearRow {
    /// `substr(booking_date, 6, 2)`.
    pub month: String,
    pub category_id: Option<i64>,
    pub name: Option<String>,
    pub kind: String,
    pub income: f64,
    pub outgoing: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct YearTotalRow {
    pub year: i64,
    pub income: f64,
    pub spending: f64,
}

/// A payment of the last 14 months, for the review of unusual payments.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewRow {
    pub id: i64,
    pub booking_date: String,
    pub amount_cents: i64,
    pub counterparty_name: Option<String>,
    pub description: String,
    pub category_name: Option<String>,
    /// In the main currency, 0 without a rate.
    pub main: f64,
}

/// A transaction as the recurring-payment scan reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct RecurringRow {
    pub id: i64,
    pub booking_date: String,
    pub amount_cents: i64,
    pub counterparty_name: Option<String>,
    pub description: String,
    pub bank_counterparty: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub account_id: i64,
    pub account_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GoalRow {
    pub id: i64,
    pub name: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub account_currency: Option<String>,
    pub saved_cents: Option<i64>,
    pub archived: bool,
}

/// Every column of a goal row that `goals.update` writes.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalWrite {
    pub name: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub saved_cents: Option<i64>,
    pub archived: bool,
}

/// Two unpaired transactions in different accounts a few days apart (`o` out, `i` in).
#[derive(Debug, Clone, PartialEq)]
pub struct TransferCandidate {
    pub oid: i64,
    pub iid: i64,
    pub o_date: String,
    pub i_date: String,
    pub o_amount: i64,
    pub i_amount: i64,
    pub o_currency: String,
    pub i_currency: String,
    pub o_name: String,
    pub i_name: String,
    pub o_cp_iban: Option<String>,
    pub i_cp_iban: Option<String>,
    pub o_acc_iban: Option<String>,
    pub i_acc_iban: Option<String>,
    pub o_cost_pct: Option<f64>,
}

/// What pairing needs to know of one half.
#[derive(Debug, Clone, PartialEq)]
pub struct PairTx {
    pub id: i64,
    pub account_id: i64,
    pub amount_cents: i64,
    pub currency: String,
    pub booking_date: String,
    pub transfer_pair: Option<String>,
    pub fx_cost_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairHalf {
    pub id: i64,
    pub amount_cents: i64,
    pub currency: String,
}

/* ----- imports ----- */

/// A transaction as duplicate detection looks at it.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedTx {
    pub id: i64,
    pub booking_date: String,
    pub counterparty_name: Option<String>,
    pub description: String,
    pub bank_counterparty: Option<String>,
    pub bank_description: Option<String>,
    pub bank_reference: Option<String>,
    pub fingerprint: Option<String>,
}

/// A transaction whose readable text differs from the bank's own (tidied in an earlier import).
#[derive(Debug, Clone, PartialEq)]
pub struct TidiedTx {
    pub counterparty_name: Option<String>,
    pub description: String,
    pub bank_counterparty: Option<String>,
    pub bank_description: String,
    pub counterparty_iban: Option<String>,
    pub communication: Option<String>,
    pub amount_cents: i64,
}

/// A committed import batch with how many of its transactions are still there.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchRow {
    pub id: i64,
    pub file_name: String,
    pub account_name: String,
    pub row_count: i64,
    pub committed_at: String,
    pub remaining: i64,
}
