//! The typed queries of the business operations (`kb-core`). Every statement behind them is in `sqlite_queries.rs`;
//! `kb-core` never writes SQL. They are plain reads and writes: all decisions (validation, merging, error texts) stay in
//! `kb-core`, which makes this the surface a second storage engine has to implement.
use crate::error::DbResult;
use crate::rows::*;

pub trait Queries {
    /* ----- settings, audit ----- */
    fn settings_rows(&self) -> DbResult<Vec<(String, String)>>;
    fn setting_get(&self, key: &str) -> DbResult<Option<String>>;
    fn setting_set(&self, key: &str, value: &str) -> DbResult<()>;
    fn audit_insert(&self, actor: &str, action: &str, details: &str) -> DbResult<()>;

    /* ----- accounts, balances, valuations ----- */
    /// Ordered by archived, then name.
    fn accounts_all(&self) -> DbResult<Vec<AccountRow>>;
    fn account_get(&self, id: i64) -> DbResult<Option<AccountRow>>;
    /// `DbError::Unique` when the IBAN exists.
    fn account_insert(&self, new: &NewAccount) -> DbResult<AccountRow>;
    fn account_update(&self, row: &AccountRow) -> DbResult<()>;
    /// Moves the transactions of an account from one currency to another (a corrected account currency).
    fn account_recurrency_transactions(&self, account_id: i64, from: &str, to: &str) -> DbResult<()>;
    fn account_balance_rows(&self) -> DbResult<Vec<BalanceRow>>;
    /// Accounts that have recorded values or balances, in the order the engine returns them.
    fn accounts_with_valuations(&self) -> DbResult<Vec<i64>>;
    /// Sum of the account's transactions in `currency` after `after` up to and including `up_to` (either end open).
    fn tx_sum(&self, account_id: i64, currency: &str, after: Option<&str>, up_to: Option<&str>) -> DbResult<f64>;
    /// `fx(cents, from, date, to)` of the store.
    fn fx_convert(&self, cents: f64, from: &str, date: &str, to: &str) -> DbResult<Option<f64>>;
    /// Oldest first.
    fn checkpoints(&self, account_id: i64) -> DbResult<Vec<CheckpointRow>>;
    /// Newest first.
    fn valuations_list(&self, account_id: i64) -> DbResult<Vec<ValuationRow>>;
    fn valuation_upsert(&self, account_id: i64, date: &str, value_cents: i64, note: Option<&str>) -> DbResult<()>;
    fn valuation_delete(&self, account_id: i64, date: &str) -> DbResult<()>;

    /* ----- categories ----- */
    /// Ordered by kind, sort order, name.
    fn categories_all(&self) -> DbResult<Vec<CategoryRow>>;
    fn category_exists(&self, id: i64) -> DbResult<bool>;
    /// Appends after the highest sort order. `DbError::Unique` when the name exists (case-insensitive).
    fn category_insert(&self, name: &str, kind: &str) -> DbResult<i64>;
    fn category_set_name(&self, id: i64, name: &str) -> DbResult<()>;
    fn category_set_archived(&self, id: i64, archived: bool) -> DbResult<()>;

    /* ----- transactions ----- */
    /// A page (newest first, id descending) and the totals of the whole filter converted to `main`.
    fn tx_page(&self, filter: &TxFilterRow, limit: i64, offset: i64, main: &str) -> DbResult<(Vec<TxRow>, TxTotals)>;
    fn tx_get(&self, id: i64) -> DbResult<Option<TxRow>>;
    fn tx_insert(&self, new: &NewTxRow) -> DbResult<i64>;
    fn tx_update(&self, id: i64, edit: &TxEdit) -> DbResult<()>;
    /// Returns how many rows changed (0 or 1).
    fn tx_set_category(&self, id: i64, category_id: Option<i64>, only_uncategorised: bool) -> DbResult<u64>;
    fn tx_set_counterparty(&self, id: i64, name: &str) -> DbResult<u64>;
    fn tx_delete(&self, id: i64) -> DbResult<u64>;
    fn tx_amount(&self, id: i64) -> DbResult<Option<i64>>;
    fn splits_list(&self, tx_id: i64) -> DbResult<Vec<SplitRow>>;
    fn splits_replace(&self, tx_id: i64, parts: &[NewSplit]) -> DbResult<()>;
    /// In rule order: priority, counterparty rules first, longest pattern, id.
    fn rules_all(&self) -> DbResult<Vec<RuleRow>>;

    /* ----- exchange rates ----- */
    fn fx_manual_rates(&self, currency: Option<&str>) -> DbResult<Vec<FxRateRow>>;
    fn fx_set_manual_rate(&self, currency: &str, date: &str, per_eur: f64) -> DbResult<()>;
    fn fx_delete_manual_rate(&self, currency: &str, date: &str) -> DbResult<()>;
    /// Currencies of accounts, transactions, `main` and manual rates, in the order the engine returns them.
    fn fx_used_currencies(&self, main: &str) -> DbResult<Vec<String>>;
    /// The facts `fx.status` shows for one currency.
    fn fx_currency_facts(&self, currency: &str) -> DbResult<FxCurrencyFacts>;

    /* ----- imported settings reset ----- */
    fn import_reset_facts(&self, keep_sync_key: bool) -> DbResult<ImportResetFacts>;
    /// Deletes the settings `keys`, the AI keys, the sync secrets (unless `keep_sync_key`), the memory and the tips,
    /// and (unless `keep_sync_key`) switches sync off and clears its state. Tables a file from an older version lacks are
    /// skipped.
    fn import_reset_apply(&self, keys: &[&str], keep_sync_key: bool) -> DbResult<()>;
}
