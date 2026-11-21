//! `budgets.list`, `.set`, `.copyPrevious`.
use super::{json, run};
use crate::budgets::{copy_budgets, list_budgets, set_budget};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::{nullable, Id, IntIn, Month};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json as obj, Value};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MonthIn {
    month: Month,
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: MonthIn| json(&list_budgets(core.db()?, &i.month.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetIn {
    category_id: Id,
    month: Month,
    #[serde(deserialize_with = "nullable")]
    amount_cents: Option<IntIn<0, 10_000_000_000>>,
}

pub fn set<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: SetIn| json(&set_budget(core.db()?, i.category_id.0, &i.month.0, i.amount_cents.map(|a| a.0))?))
}

pub fn copy_previous<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: MonthIn| Ok(obj!({ "copied": copy_budgets(core.db()?, &i.month.0)? })))
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["budgets.list", "budgets.set", "budgets.copyPrevious"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "budgets.list" => list::<S>,
        "budgets.set" => set::<S>,
        "budgets.copyPrevious" => copy_previous::<S>,
        _ => return None,
    })
}
