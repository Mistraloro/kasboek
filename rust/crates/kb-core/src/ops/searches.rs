//! `searches.save`, `searches.delete`: saved filters of the Transactions page, kept in the settings.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::{AppError, AppResult};
use crate::input::{is_none, optional, Date, Id, IdOrNone, Month, Plain, Trimmed};
use crate::settings::{get_settings, update_settings};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FilterIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    account_id: Option<Id>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    category_id: Option<IdOrNone>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    month: Option<Month>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    from: Option<Date>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    to: Option<Date>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    search: Option<Plain<100>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    direction: Option<Direction>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SaveIn {
    name: Trimmed<1, 60>,
    filter: FilterIn,
}

/// The saved searches as an array; anything else in the settings makes the TypeScript `.filter` throw.
fn saved(settings: &Map<String, Value>) -> AppResult<Vec<Value>> {
    settings.get("savedSearches").and_then(Value::as_array).cloned().ok_or_else(AppError::failed)
}

fn store_searches<S: Store>(db: &S, list: Vec<Value>) -> AppResult<Value> {
    let mut patch = Map::new();
    patch.insert("savedSearches".into(), Value::Array(list));
    let settings = update_settings(db, &patch)?;
    Ok(settings.get("savedSearches").cloned().unwrap_or(Value::Null))
}

pub fn save<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: SaveIn| {
        let db = core.db()?;
        // Saving under an existing name replaces it; the newest first.
        let mut list: Vec<Value> =
            saved(&get_settings(db)?)?.into_iter().filter(|s| s.get("name").and_then(Value::as_str) != Some(&input.name.0)).collect();
        list.insert(0, json(&input)?);
        list.truncate(30);
        store_searches(db, list)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeleteIn {
    name: Plain<60>,
}

pub fn delete<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: DeleteIn| {
        let db = core.db()?;
        let list =
            saved(&get_settings(db)?)?.into_iter().filter(|s| s.get("name").and_then(Value::as_str) != Some(&input.name.0)).collect();
        store_searches(db, list)
    })
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["searches.save", "searches.delete"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "searches.save" => save::<S>,
        "searches.delete" => delete::<S>,
        _ => return None,
    })
}
