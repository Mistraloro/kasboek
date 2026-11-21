//! `settings.get`, `settings.update`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::{is_none, optional, Currency, Empty};
use crate::settings::{get_settings, update_settings};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn get<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&get_settings(core.db()?)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    currency: Option<Currency>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    fx_auto_update: Option<bool>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    hide_account_numbers: Option<bool>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    assistant_enabled: Option<bool>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: UpdateIn| {
        let Value::Object(patch) = serde_json::to_value(&input).map_err(|_| crate::error::AppError::failed())? else {
            return Err(crate::error::AppError::failed());
        };
        json(&update_settings(core.db()?, &patch)?)
    })
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["settings.get", "settings.update"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "settings.get" => get::<S>,
        "settings.update" => update::<S>,
        _ => return None,
    })
}
