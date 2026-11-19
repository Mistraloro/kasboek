//! Bank balances and recorded values: src/core/balance.ts and the valuation helpers of src/core/wealth.ts.
//!
//! The balance the bank showed on a day (end of that day) is a checkpoint, stored as a valuation. An account's balance on
//! any day follows from the nearest checkpoint and the transactions in between, so the starting balance never has to be
//! known. Amounts that went through `fx()` are floating point, as in TypeScript.
use crate::error::{AppError, AppResult};
use kb_db::rows::{CheckpointRow, ValuationRow};
use kb_db::Store;
use serde::Serialize;

fn account<S: Store>(store: &S, id: i64) -> AppResult<kb_db::rows::AccountRow> {
    store.account_get(id)?.ok_or_else(|| AppError::new("accounts.not_found", "Account not found."))
}

/// The balance at the end of `date`: from the latest checkpoint on or before it, else back from the first one after it,
/// else the opening balance plus everything up to that day.
pub fn balance_on<S: Store>(store: &S, account_id: i64, date: &str, ignore_date: Option<&str>) -> AppResult<f64> {
    let a = account(store, account_id)?;
    let cps: Vec<CheckpointRow> = store.checkpoints(account_id)?.into_iter().filter(|c| Some(c.date.as_str()) != ignore_date).collect();
    if let Some(prev) = cps.iter().rfind(|c| c.date.as_str() <= date) {
        return Ok(prev.value as f64 + store.tx_sum(account_id, &a.currency, Some(&prev.date), Some(date))?);
    }
    if let Some(next) = cps.iter().find(|c| c.date.as_str() > date) {
        return Ok(next.value as f64 - store.tx_sum(account_id, &a.currency, Some(date), Some(&next.date))?);
    }
    Ok(a.opening_balance_cents as f64 + store.tx_sum(account_id, &a.currency, None, Some(date))?)
}

/// The balance now: the latest checkpoint plus every transaction after it (also ones dated later).
pub fn current_balance<S: Store>(store: &S, account_id: i64) -> AppResult<f64> {
    let a = account(store, account_id)?;
    match store.checkpoints(account_id)?.last() {
        Some(last) => Ok(last.value as f64 + store.tx_sum(account_id, &a.currency, Some(&last.date), None)?),
        None => Ok(a.opening_balance_cents as f64 + store.tx_sum(account_id, &a.currency, None, None)?),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankBalanceResult {
    pub date: String,
    pub balance_cents: i64,
    pub expected_cents: Option<f64>,
    pub difference_cents: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankBalance {
    pub date: String,
    pub balance_cents: i64,
    pub note: Option<String>,
    pub expected_cents: Option<f64>,
    pub difference_cents: Option<f64>,
    pub since: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
    pub account_id: i64,
    pub date: String,
    pub value_cents: i64,
    pub note: Option<String>,
}

pub fn list_valuations<S: Store>(store: &S, account_id: i64) -> AppResult<Vec<Valuation>> {
    Ok(store
        .valuations_list(account_id)?
        .into_iter()
        .map(|ValuationRow { account_id, date, value_cents, note }| Valuation { account_id, date, value_cents, note })
        .collect())
}

pub fn set_valuation<S: Store>(store: &S, account_id: i64, date: &str, value_cents: i64, note: Option<&str>) -> AppResult<Vec<Valuation>> {
    if store.account_get(account_id)?.is_none() {
        return Err(AppError::new("accounts.not_found", "Account not found."));
    }
    store.valuation_upsert(account_id, date, value_cents, note)?;
    list_valuations(store, account_id)
}

pub fn delete_valuation<S: Store>(store: &S, account_id: i64, date: &str) -> AppResult<Vec<Valuation>> {
    store.valuation_delete(account_id, date)?;
    list_valuations(store, account_id)
}

/// Records what the bank showed on a day and compares it with what Kasboek expected from the other checkpoints, so a
/// missing or doubled transaction shows up as a difference.
pub fn set_bank_balance<S: Store>(
    store: &S,
    account_id: i64,
    date: &str,
    balance_cents: i64,
    note: Option<&str>,
    today: &str,
) -> AppResult<BankBalanceResult> {
    let a = account(store, account_id)?;
    if a.kind == "investment" {
        return Err(AppError::new(
            "balance.investment",
            "An investment account has a value, not a bank balance: record it as a value (valuations.set, or Set value on the Net worth page).",
        ));
    }
    if date > today {
        return Err(AppError::new("balance.future", "Enter the balance of today or an earlier day."));
    }
    let others = store.checkpoints(account_id)?.into_iter().filter(|c| c.date != date).count();
    let expected = if others > 0 || a.opening_balance_cents != 0 { Some(balance_on(store, account_id, date, Some(date))?) } else { None };
    set_valuation(store, account_id, date, balance_cents, note)?;
    Ok(BankBalanceResult {
        date: date.to_owned(),
        balance_cents,
        expected_cents: expected,
        difference_cents: expected.map(|e| balance_cents as f64 - e),
    })
}

/// The recorded balances, newest first, each compared with the one before it.
pub fn list_bank_balances<S: Store>(store: &S, account_id: i64) -> AppResult<Vec<BankBalance>> {
    let a = account(store, account_id)?;
    let cps = store.checkpoints(account_id)?;
    let mut out = Vec::with_capacity(cps.len());
    for (i, c) in cps.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| &cps[p]);
        let expected = match prev {
            Some(p) => Some(p.value as f64 + store.tx_sum(account_id, &a.currency, Some(&p.date), Some(&c.date))?),
            None => None,
        };
        out.push(BankBalance {
            date: c.date.clone(),
            balance_cents: c.value,
            note: c.note.clone(),
            expected_cents: expected,
            difference_cents: if a.kind == "investment" { None } else { expected.map(|e| c.value as f64 - e) },
            since: prev.map(|p| p.date.clone()),
        });
    }
    out.reverse();
    Ok(out)
}
