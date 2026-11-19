//! The ported operations and the table that finds them. Each operation parses its input (see `input.rs`), does what the
//! TypeScript handler in src/core/ops.ts does, and returns its result as JSON with the same field names.
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::parse_input;
use kb_db::Store;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

mod accounts;
mod balances;
mod budgets;
mod categories;
mod fx;
mod goals;
mod prefs;
mod recurring;
mod rules;
mod searches;
mod settings;
mod summary;
mod transactions;
mod transfers;

pub type Handler<S> = fn(&Core<S>, Value) -> AppResult<Done>;

/// Parses `raw` as `I`, runs `f`, and pairs the result with the parsed input for the audit log.
pub(crate) fn run<I, F>(raw: Value, f: F) -> AppResult<Done>
where
    I: DeserializeOwned + Serialize,
    F: FnOnce(I) -> AppResult<Value>,
{
    let input: I = parse_input(raw)?;
    let audit = serde_json::to_value(&input).unwrap_or(Value::Null);
    Ok(Done { data: f(input)?, audit })
}

pub(crate) fn json<T: Serialize>(value: &T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|_| crate::error::AppError::failed())
}

/// The ported operations by name; everything else in the contract answers `op.not_ported`.
pub fn handler<S: Store>(name: &str) -> Option<Handler<S>> {
    Some(match name {
        "prefs.get" => prefs::get::<S>,
        "prefs.update" => prefs::update::<S>,
        "settings.get" => settings::get::<S>,
        "settings.update" => settings::update::<S>,
        "searches.save" => searches::save::<S>,
        "searches.delete" => searches::delete::<S>,
        "accounts.list" => accounts::list::<S>,
        "accounts.create" => accounts::create::<S>,
        "accounts.update" => accounts::update::<S>,
        "categories.list" => categories::list::<S>,
        "categories.create" => categories::create::<S>,
        "categories.update" => categories::update::<S>,
        "balances.list" => balances::list::<S>,
        "balances.set" => balances::set::<S>,
        "valuations.list" => balances::valuations_list::<S>,
        "valuations.set" => balances::valuations_set::<S>,
        "valuations.delete" => balances::valuations_delete::<S>,
        "fx.status" => fx::status::<S>,
        "fx.rates" => fx::rates::<S>,
        "fx.setRate" => fx::set_rate::<S>,
        "fx.deleteRate" => fx::delete_rate::<S>,
        "transactions.list" => transactions::list::<S>,
        "transactions.create" => transactions::create::<S>,
        "transactions.update" => transactions::update::<S>,
        "transactions.edit" => transactions::edit::<S>,
        "transactions.splits" => transactions::splits::<S>,
        "transactions.split" => transactions::split::<S>,
        "transactions.rename" => transactions::rename::<S>,
        "transactions.categorize" => transactions::categorize::<S>,
        "transactions.delete" => transactions::delete::<S>,
        "rules.list" => rules::list::<S>,
        "rules.create" => rules::create::<S>,
        "rules.preview" => rules::preview::<S>,
        "rules.update" => rules::update::<S>,
        "rules.reorder" => rules::reorder::<S>,
        "rules.delete" => rules::delete::<S>,
        "budgets.list" => budgets::list::<S>,
        "budgets.set" => budgets::set::<S>,
        "budgets.copyPrevious" => budgets::copy_previous::<S>,
        "summary.month" => summary::month::<S>,
        "summary.year" => summary::year::<S>,
        "summary.review" => summary::review::<S>,
        "networth.summary" => summary::networth::<S>,
        "alerts.list" => summary::alerts::<S>,
        "goals.list" => goals::list::<S>,
        "goals.create" => goals::create::<S>,
        "goals.update" => goals::update::<S>,
        "goals.delete" => goals::delete::<S>,
        "recurring.list" => recurring::list::<S>,
        "recurring.hide" => recurring::hide::<S>,
        "transfers.find" => transfers::find::<S>,
        "transfers.pair" => transfers::pair::<S>,
        "transfers.unpair" => transfers::unpair::<S>,
        "transfers.cost" => transfers::cost::<S>,
        "transfers.setCost" => transfers::set_cost::<S>,
        _ => return None,
    })
}

/// The names `handler` knows, for the test that compares them with the contract.
pub const PORTED: &[&str] = &[
    "prefs.get",
    "prefs.update",
    "settings.get",
    "settings.update",
    "searches.save",
    "searches.delete",
    "accounts.list",
    "accounts.create",
    "accounts.update",
    "categories.list",
    "categories.create",
    "categories.update",
    "balances.list",
    "balances.set",
    "valuations.list",
    "valuations.set",
    "valuations.delete",
    "fx.status",
    "fx.rates",
    "fx.setRate",
    "fx.deleteRate",
    "transactions.list",
    "transactions.create",
    "transactions.update",
    "transactions.edit",
    "transactions.splits",
    "transactions.split",
    "transactions.rename",
    "transactions.categorize",
    "transactions.delete",
    "rules.list",
    "rules.create",
    "rules.preview",
    "rules.update",
    "rules.reorder",
    "rules.delete",
    "budgets.list",
    "budgets.set",
    "budgets.copyPrevious",
    "summary.month",
    "summary.year",
    "summary.review",
    "networth.summary",
    "alerts.list",
    "goals.list",
    "goals.create",
    "goals.update",
    "goals.delete",
    "recurring.list",
    "recurring.hide",
    "transfers.find",
    "transfers.pair",
    "transfers.unpair",
    "transfers.cost",
    "transfers.setCost",
];
