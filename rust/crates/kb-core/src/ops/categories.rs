//! `categories.list`, `categories.create`, `categories.update`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::finance::{create_category, list_categories, update_category};
use crate::input::{is_none, optional, Empty, Id, Trimmed};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&list_categories(core.db()?)?))
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Expense,
    Income,
    Transfer,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CreateIn {
    name: Trimmed<1, 60>,
    kind: Kind,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: CreateIn| {
        let db = core.db()?;
        let kind = match input.kind {
            Kind::Expense => "expense",
            Kind::Income => "income",
            Kind::Transfer => "transfer",
        };
        create_category(db, &input.name.0, kind)?;
        json(&list_categories(db)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UpdateIn {
    id: Id,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    name: Option<Trimmed<1, 60>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    archived: Option<bool>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: UpdateIn| {
        let db = core.db()?;
        update_category(db, input.id.0, input.name.as_ref().map(|n| n.0.as_str()), input.archived)?;
        json(&list_categories(db)?)
    })
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["categories.list", "categories.create", "categories.update"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "categories.list" => list::<S>,
        "categories.create" => create::<S>,
        "categories.update" => update::<S>,
        _ => return None,
    })
}
