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
mod export;
mod fx;
mod goals;
mod import;
mod insights;
mod memory;
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

/// Like `run` for an operation that writes nothing: the audit log never sees its input, so it is not copied (an import
/// carries the whole file).
pub(crate) fn run_quiet<I, F>(raw: Value, f: F) -> AppResult<Done>
where
    I: DeserializeOwned,
    F: FnOnce(I) -> AppResult<Value>,
{
    let input: I = parse_input(raw)?;
    Ok(Done { data: f(input)?, audit: Value::Null })
}

pub(crate) fn json<T: Serialize>(value: &T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|_| crate::error::AppError::failed())
}

/// One registry per area file: its `handler` and its `PORTED` names. A batch that ports operations fills in its own file only.
type AreaHandler<S> = fn(&str) -> Option<Handler<S>>;

fn areas<S: Store>() -> [AreaHandler<S>; 18] {
    [
        accounts::handler::<S>,
        balances::handler::<S>,
        budgets::handler::<S>,
        categories::handler::<S>,
        export::handler::<S>,
        fx::handler::<S>,
        goals::handler::<S>,
        import::handler::<S>,
        insights::handler::<S>,
        memory::handler::<S>,
        prefs::handler::<S>,
        recurring::handler::<S>,
        rules::handler::<S>,
        searches::handler::<S>,
        settings::handler::<S>,
        summary::handler::<S>,
        transactions::handler::<S>,
        transfers::handler::<S>,
    ]
}

const AREA_PORTED: [&[&str]; 18] = [
    accounts::PORTED,
    balances::PORTED,
    budgets::PORTED,
    categories::PORTED,
    export::PORTED,
    fx::PORTED,
    goals::PORTED,
    import::PORTED,
    insights::PORTED,
    memory::PORTED,
    prefs::PORTED,
    recurring::PORTED,
    rules::PORTED,
    searches::PORTED,
    settings::PORTED,
    summary::PORTED,
    transactions::PORTED,
    transfers::PORTED,
];

/// The ported operations by name; everything else in the contract answers `op.not_ported`.
pub fn handler<S: Store>(name: &str) -> Option<Handler<S>> {
    areas::<S>().iter().find_map(|area| area(name))
}

/// The names `handler` knows, for the test that compares them with the contract.
pub fn ported() -> Vec<&'static str> {
    AREA_PORTED.iter().flat_map(|names| names.iter().copied()).collect()
}
