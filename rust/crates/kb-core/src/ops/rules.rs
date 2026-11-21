//! `rules.list`, `.create`, `.preview`, `.update`, `.reorder`, `.delete`.
use super::{json, run};
use crate::core::Actor;
use crate::core::{Core, Done};
use crate::error::AppError;
use crate::error::AppResult;
use crate::input::{is_none, nullable, optional, Empty, Id, LenVec, Trimmed};
use crate::rules::{create_rule, delete_rule, list_rules, preview_rule, reorder_rules, rule_pattern, update_rule, RuleChange};
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

/// The text a new or previewed rule looks for: the given pattern, or the account number of a transaction.
fn given_pattern<S: Store>(
    db: &S,
    field: Field,
    pattern: Option<&str>,
    from_transaction_id: Option<Id>,
    actor: Actor,
) -> AppResult<String> {
    rule_pattern(db, Some(field.as_str()), pattern, from_transaction_id.map(|t| t.0), actor == Actor::Assistant)?
        .ok_or_else(|| AppError::new("rules.pattern", "Give the text the rule looks for (pattern)."))
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&list_rules(core.db()?)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateIn {
    field: Field,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    pattern: Option<Trimmed<2, 100>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    from_transaction_id: Option<Id>,
    #[serde(default, rename = "match")]
    match_kind: Match,
    category_id: Id,
    #[serde(default = "yes")]
    apply_to_existing: bool,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CreateIn| {
        let db = core.db()?;
        let pattern = given_pattern(db, i.field, i.pattern.as_ref().map(|p| p.0.as_str()), i.from_transaction_id, core.actor())?;
        json(&create_rule(db, i.field.as_str(), &pattern, i.match_kind.as_str(), i.category_id.0, i.apply_to_existing)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreviewIn {
    field: Field,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    pattern: Option<Trimmed<1, 100>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    from_transaction_id: Option<Id>,
    #[serde(default, rename = "match")]
    match_kind: Match,
    #[serde(default, deserialize_with = "nullable")]
    category_id: Option<Id>,
}

pub fn preview<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: PreviewIn| {
        let db = core.db()?;
        let pattern = given_pattern(db, i.field, i.pattern.as_ref().map(|p| p.0.as_str()), i.from_transaction_id, core.actor())?;
        json(&preview_rule(db, i.field.as_str(), &pattern, i.match_kind.as_str(), i.category_id.map(|c| c.0))?)
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
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    from_transaction_id: Option<Id>,
    #[serde(default, rename = "match", deserialize_with = "optional", skip_serializing_if = "is_none")]
    match_kind: Option<Match>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    category_id: Option<Id>,
    #[serde(default)]
    apply_to_existing: bool,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: UpdateIn| {
        let db = core.db()?;
        let from_assistant = core.actor() == Actor::Assistant;
        let old = list_rules(db)?.into_iter().find(|r| r.id == i.id.0);
        let field = i.field.map(Field::as_str).or(old.as_ref().map(|r| r.field.as_str()));
        let pattern = i.pattern.as_ref().map(|p| p.0.as_str());
        // The assistant can't see the stored account number: moving the rule to another field without a new text would keep it as that text.
        if from_assistant && old.as_ref().is_some_and(|r| r.field == "iban") && field != Some("iban") && pattern.is_none() {
            return Err(AppError::new(
                "rules.iban_field",
                "This rule looks for an account number, which is hidden from you. To change where it looks, also give the new text (pattern).",
            ));
        }
        let pattern = rule_pattern(db, field, pattern, i.from_transaction_id.map(|t| t.0), from_assistant)?;
        json(&update_rule(
            db,
            &RuleChange {
                id: i.id.0,
                field: i.field.map(Field::as_str),
                pattern: pattern.as_deref(),
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

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["rules.list", "rules.create", "rules.preview", "rules.update", "rules.reorder", "rules.delete"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "rules.list" => list::<S>,
        "rules.create" => create::<S>,
        "rules.preview" => preview::<S>,
        "rules.update" => update::<S>,
        "rules.reorder" => reorder::<S>,
        "rules.delete" => delete::<S>,
        _ => return None,
    })
}
