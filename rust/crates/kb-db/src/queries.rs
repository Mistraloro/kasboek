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

    /* ----- rules ----- */
    /// `DbError::Unique` when the same text exists for the field (case-insensitive).
    fn rule_insert(&self, field: &str, pattern: &str, match_kind: &str, category_id: i64) -> DbResult<i64>;
    /// `DbError::Unique` as for `rule_insert`.
    fn rule_update(&self, id: i64, field: &str, pattern: &str, match_kind: &str, category_id: i64) -> DbResult<()>;
    fn rule_set_priority(&self, id: i64, priority: i64) -> DbResult<()>;
    fn rule_delete(&self, id: i64) -> DbResult<()>;
    /// The text columns of all transactions, or only the uncategorised ones, in id order.
    fn rule_texts(&self, only_uncategorised: bool) -> DbResult<Vec<RuleTextRow>>;

    /* ----- budgets and summaries ----- */
    fn category_kind(&self, id: i64) -> DbResult<Option<String>>;
    /// Spending per category in `[from, to)`: money out minus refunds, transfers excluded; split lines count by part.
    fn spent_by_category(&self, main: &str, from: &str, to: &str) -> DbResult<Vec<(Option<i64>, f64)>>;
    /// Expense categories (not archived, or with a budget) with their budget of `month`.
    fn budget_categories(&self, month: &str) -> DbResult<Vec<BudgetCategoryRow>>;
    fn budget_delete(&self, category_id: i64, month: &str) -> DbResult<()>;
    fn budget_upsert(&self, category_id: i64, month: &str, amount_cents: i64) -> DbResult<()>;
    /// Copies the budgets of `from_month` to `month` where none is set; returns how many rows were added.
    fn budgets_copy(&self, month: &str, from_month: &str) -> DbResult<u64>;
    /// Sum of the budgets of months `from` to `to` inclusive.
    fn budgets_sum(&self, from: &str, to: &str) -> DbResult<i64>;
    /// `(income, spending)` of `[from, to)` in the main currency, transfers left out.
    fn income_and_spending(&self, main: &str, from: &str, to: &str) -> DbResult<(f64, f64)>;
    /// Distinct transactions with an uncategorised line in `[from, to)`.
    fn uncategorized_count(&self, from: &str, to: &str) -> DbResult<i64>;
    /// Transactions in `[from, to)` whose currency has no rate to `main`.
    fn unconverted_count(&self, main: &str, from: &str, to: &str) -> DbResult<i64>;
    fn year_rows(&self, main: &str, from: &str, to: &str) -> DbResult<Vec<YearRow>>;
    fn year_totals(&self, main: &str) -> DbResult<Vec<YearTotalRow>>;
    /// Negative payments from `from` up to (excluding) `to`, transfers left out, by date.
    fn review_rows(&self, main: &str, from: &str, to: &str) -> DbResult<Vec<ReviewRow>>;

    /* ----- net worth ----- */
    /// Per booking date the sum of the account's transactions in `currency`, by date.
    fn tx_daily_sums(&self, account_id: i64, currency: &str) -> DbResult<Vec<(String, f64)>>;
    /// The oldest transaction date, recorded value or account creation day.
    fn first_data_date(&self) -> DbResult<Option<String>>;

    /* ----- recurring payments, alerts ----- */
    /// Transactions of `[since, today]` outside transfers, by date and id.
    fn recurring_rows(&self, since: &str, today: &str) -> DbResult<Vec<RecurringRow>>;
    fn recurring_hidden_keys(&self) -> DbResult<Vec<String>>;
    fn recurring_mark_exists(&self, key: &str) -> DbResult<bool>;
    fn recurring_mark_set(&self, key: &str, hidden: bool) -> DbResult<()>;
    /// `total_changes()` of this connection.
    fn total_changes(&self) -> DbResult<i64>;
    /// Active current accounts with a known balance: `(id, name, currency)`.
    fn alert_accounts(&self) -> DbResult<Vec<(i64, String, String)>>;

    /* ----- goals ----- */
    /// Not archived first, then by date (undated last), then id.
    fn goals_all(&self) -> DbResult<Vec<GoalRow>>;
    fn goal_get(&self, id: i64) -> DbResult<Option<GoalRow>>;
    fn goal_insert(
        &self,
        name: &str,
        target_cents: i64,
        target_date: Option<&str>,
        account_id: Option<i64>,
        saved_cents: Option<i64>,
    ) -> DbResult<()>;
    fn goal_update(&self, id: i64, goal: &GoalWrite) -> DbResult<()>;
    fn goal_delete(&self, id: i64) -> DbResult<()>;

    /* ----- transfers ----- */
    fn transfer_candidates(&self) -> DbResult<Vec<TransferCandidate>>;
    fn pair_tx_get(&self, id: i64) -> DbResult<Option<PairTx>>;
    /// Sets the pair key and, unless the transaction already has a transfer category, `category_id`.
    fn pair_set(&self, id: i64, key: &str, category_id: Option<i64>) -> DbResult<()>;
    /// `None`: no such transaction. `Some(None)`: not paired.
    fn tx_transfer_pair(&self, id: i64) -> DbResult<Option<Option<String>>>;
    fn pair_halves(&self, pair: &str) -> DbResult<Vec<PairHalf>>;
    /// The id of the outgoing half of a pair.
    fn pair_out_id(&self, pair: &str) -> DbResult<Option<i64>>;
    /// A transfer category one of the transactions already has.
    fn transfer_category_of(&self, ids: &[i64]) -> DbResult<Option<i64>>;
    fn first_transfer_category(&self) -> DbResult<Option<i64>>;
    /// Active expense categories by sort order and id.
    fn expense_categories(&self) -> DbResult<Vec<(i64, String)>>;
    fn pair_clear(&self, pair: &str) -> DbResult<()>;

    /* ----- imports ----- */
    /// The saved column mapping (JSON text) of a header row, if any.
    fn csv_profile_get(&self, signature: &str) -> DbResult<Option<String>>;
    /// Saves a mapping; a layout with the same header signature only gets the new mapping.
    fn csv_profile_save(&self, name: &str, bank: Option<&str>, signature: &str, mapping_json: &str) -> DbResult<()>;
    /// The account's transactions with this fingerprint, by id.
    fn import_by_fingerprint(&self, account_id: i64, fingerprint: &str) -> DbResult<Vec<ImportedTx>>;
    /// The account's transactions with this bank reference, by id.
    fn import_by_reference(&self, account_id: i64, reference: &str) -> DbResult<Vec<ImportedTx>>;
    /// The account's transactions of this amount between two dates (inclusive), by id.
    fn import_nearby(&self, account_id: i64, amount_cents: i64, from: &str, to: &str) -> DbResult<Vec<ImportedTx>>;
    /// Transactions whose readable text differs from the bank's own, oldest first.
    fn import_tidied(&self) -> DbResult<Vec<TidiedTx>>;
    /// Starts a committed import batch and returns its id.
    fn batch_insert(&self, account_id: i64, file_name: &str, layout: Option<&str>, row_count: i64) -> DbResult<i64>;
    /// Ids of the transactions of a batch.
    fn batch_tx_ids(&self, batch_id: i64) -> DbResult<Vec<i64>>;
    /// The 20 latest committed batches, newest first.
    fn batch_list(&self) -> DbResult<Vec<BatchRow>>;
    /// Deletes the batch's transactions and marks it discarded; returns how many transactions were deleted.
    fn batch_undo(&self, batch_id: i64) -> DbResult<u64>;
}
