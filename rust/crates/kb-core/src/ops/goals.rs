//! `goals.list`, `.create`, `.update`, `.delete`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::goals::{create_goal, delete_goal, list_goals, update_goal, GoalChange, NewGoal};
use crate::input::{is_none, nullable_optional, optional, Date, Empty, Id, IntIn, Trimmed};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

type Target = IntIn<1, 1_000_000_000_000>;
type Saved = IntIn<0, 1_000_000_000_000>;

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&list_goals(core.db()?, &core.today())?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateIn {
    name: Trimmed<1, 80>,
    target_cents: Target,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    target_date: Option<Option<Date>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    account_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    saved_cents: Option<Option<Saved>>,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CreateIn| {
        let goal = NewGoal {
            name: i.name.0,
            target_cents: i.target_cents.0,
            target_date: i.target_date.flatten().map(|d| d.0),
            account_id: i.account_id.flatten().map(|a| a.0),
            saved_cents: i.saved_cents.flatten().map(|s| s.0),
        };
        json(&create_goal(core.db()?, &goal, &core.today())?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    id: Id,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    name: Option<Trimmed<1, 80>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    target_cents: Option<Target>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    target_date: Option<Option<Date>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    account_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    saved_cents: Option<Option<Saved>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    archived: Option<bool>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: UpdateIn| {
        let change = GoalChange {
            id: i.id.0,
            name: i.name.map(|n| n.0),
            target_cents: i.target_cents.map(|t| t.0),
            target_date: i.target_date.map(|d| d.map(|d| d.0)),
            account_id: i.account_id.map(|a| a.map(|a| a.0)),
            saved_cents: i.saved_cents.map(|s| s.map(|s| s.0)),
            archived: i.archived,
        };
        json(&update_goal(core.db()?, &change, &core.today())?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IdIn {
    id: Id,
}

pub fn delete<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: IdIn| json(&delete_goal(core.db()?, i.id.0, &core.today())?))
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["goals.list", "goals.create", "goals.update", "goals.delete"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "goals.list" => list::<S>,
        "goals.create" => create::<S>,
        "goals.update" => update::<S>,
        "goals.delete" => delete::<S>,
        _ => return None,
    })
}
