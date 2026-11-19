//! `rules.list`, `.create`, `.preview`, `.update`, `.reorder`, `.delete`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::{is_none, nullable, optional, Empty, Id, LenVec, Trimmed};
use crate::rules::{create_rule, delete_rule, list_rules, preview_rule, reorder_rules, update_rule, RuleChange};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Field {
    Counterparty,
    Description,
    Any,
    Iban,
}

impl Field {
    fn as_str(self) -> &'static str {
        match self {
            Self::Counterparty => "counterparty",
            Self::Description => "description",
            Self::Any => "any",
            Self::Iban => "iban",
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Match {
    #[default]
    Contains,
    Word,
    Starts,
}

impl Match {
    fn as_str(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Word => "word",
            Self::Starts => "starts",
        }
    }
}

fn yes() -> bool {
    true
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&list_rules(core.db()?)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateIn {
    field: Field,
    pattern: Trimmed<2, 100>,
    #[serde(default, rename = "match")]
    match_kind: Match,
    category_id: Id,
    #[serde(default = "yes")]
    apply_to_existing: bool,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CreateIn| {
        json(&create_rule(core.db()?, i.field.as_str(), &i.pattern.0, i.match_kind.as_str(), i.category_id.0, i.apply_to_existing)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreviewIn {
    field: Field,
    pattern: Trimmed<1, 100>,
    #[serde(default, rename = "match")]
    match_kind: Match,
    #[serde(default, deserialize_with = "nullable")]
    category_id: Option<Id>,
}

pub fn preview<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: PreviewIn| {
        json(&preview_rule(core.db()?, i.field.as_str(), &i.pattern.0, i.match_kind.as_str(), i.category_id.map(|c| c.0))?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    id: Id,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    field: Option<Field>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    pattern: Option<Trimmed<2, 100>>,
    #[serde(default, rename = "match", deserialize_with = "optional", skip_serializing_if = "is_none")]
    match_kind: Option<Match>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    category_id: Option<Id>,
    #[serde(default)]
    apply_to_existing: bool,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: UpdateIn| {
        json(&update_rule(
            core.db()?,
            &RuleChange {
                id: i.id.0,
                field: i.field.map(Field::as_str),
                pattern: i.pattern.as_ref().map(|p| p.0.as_str()),
                match_kind: i.match_kind.map(Match::as_str),
                category_id: i.category_id.map(|c| c.0),
                apply_to_existing: i.apply_to_existing,
            },
        )?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReorderIn {
    ids: LenVec<Id, 1, 5000>,
}

pub fn reorder<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: ReorderIn| {
        let ids: Vec<i64> = i.ids.0.iter().map(|id| id.0).collect();
        json(&reorder_rules(core.db()?, &ids)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IdIn {
    id: Id,
}

pub fn delete<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: IdIn| {
        let db = core.db()?;
        delete_rule(db, i.id.0)?;
        json(&list_rules(db)?)
    })
}
