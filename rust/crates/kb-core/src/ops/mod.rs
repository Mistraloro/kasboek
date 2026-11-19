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
mod categories;
mod fx;
mod prefs;
mod searches;
mod settings;
mod transactions;

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
];
