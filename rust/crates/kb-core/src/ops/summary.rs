//! `summary.month`, `summary.year`, `summary.review`, `networth.summary`, `alerts.list`.
use super::{json, run};
use crate::alerts::list_alerts;
use crate::budgets::month_summary;
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::{Empty, IntIn, Month};
use crate::review::month_review;
use crate::wealth::{net_worth, year_summary};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MonthIn {
    month: Month,
}

pub fn month<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: MonthIn| json(&month_summary(core.db()?, &i.month.0)?))
}

pub fn review<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: MonthIn| json(&month_review(core.db()?, &i.month.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct YearIn {
    year: IntIn<1900, 2200>,
}

pub fn year<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: YearIn| json(&year_summary(core.db()?, i.year.0)?))
}

fn default_months() -> IntIn<0, 600> {
    IntIn(24)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NetWorthIn {
    #[serde(default = "default_months")]
    months: IntIn<0, 600>,
}

pub fn networth<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: NetWorthIn| json(&net_worth(core.db()?, i.months.0, &core.today())?))
}

pub fn alerts<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&list_alerts(core, &core.today())?))
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["summary.month", "summary.year", "summary.review", "networth.summary", "alerts.list"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "summary.month" => month::<S>,
        "summary.year" => year::<S>,
        "summary.review" => review::<S>,
        "networth.summary" => networth::<S>,
        "alerts.list" => alerts::<S>,
        _ => return None,
    })
}
