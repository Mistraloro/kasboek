//! `balances.list`, `balances.set`, `valuations.list`, `valuations.set`, `valuations.delete`.
use super::{json, run};
use crate::balance::{delete_valuation, list_bank_balances, list_valuations, set_bank_balance, set_valuation};
use crate::core::{Core, Done};
use crate::error::{AppError, AppResult};
use crate::input::{is_none, nullable_optional, Date, Id, Int, Trimmed};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AccountIn {
    account_id: Id,
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: AccountIn| json(&list_bank_balances(core.db()?, input.account_id.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetBalanceIn {
    account_id: Id,
    date: Date,
    balance_cents: Int,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    note: Option<Option<Trimmed<0, 200>>>,
}

pub fn set<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: SetBalanceIn| {
        let note = i.note.as_ref().and_then(|n| n.as_ref()).map(|n| n.0.as_str());
        json(&set_bank_balance(core.db()?, i.account_id.0, &i.date.0, i.balance_cents.0, note, &core.today())?)
    })
}

pub fn valuations_list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: AccountIn| json(&list_valuations(core.db()?, input.account_id.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetValuationIn {
    account_id: Id,
    date: Date,
    value_cents: Int,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    note: Option<Option<Trimmed<0, 200>>>,
}

pub fn valuations_set<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: SetValuationIn| {
        let db = core.db()?;
        // A value is the market value of an investment; for a bank account it is the bank balance.
        if let Some(account) = db.account_get(i.account_id.0)? {
            if account.kind != "investment" {
                return Err(AppError::new(
                    "valuations.bank_account",
                    "For a bank account, record the balance the bank shows instead (balances.set, or Bank balance in Settings → Accounts).",
                ));
            }
        }
        let note = i.note.as_ref().and_then(|n| n.as_ref()).map(|n| n.0.as_str());
        json(&set_valuation(db, i.account_id.0, &i.date.0, i.value_cents.0, note)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeleteIn {
    account_id: Id,
    date: Date,
}

pub fn valuations_delete<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: DeleteIn| json(&delete_valuation(core.db()?, i.account_id.0, &i.date.0)?))
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["balances.list", "balances.set", "valuations.list", "valuations.set", "valuations.delete"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "balances.list" => list::<S>,
        "balances.set" => set::<S>,
        "valuations.list" => valuations_list::<S>,
        "valuations.set" => valuations_set::<S>,
        "valuations.delete" => valuations_delete::<S>,
        _ => return None,
    })
}
