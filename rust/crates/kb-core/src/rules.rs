//! Categorisation rules: list, preview, create, update, reorder, delete (the rules part of src/core/finance.ts). Matching
//! itself is in `finance.rs`.
use crate::error::{AppError, AppResult};
use crate::finance::{categorize_transactions, norm_iban, require_category, rule_matches, RuleText};
use crate::jsstr::{js_trim, slice_units};
use kb_db::rows::RuleTextRow;
use kb_db::{DbError, Store};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Short texts match too much anywhere ("Q8" inside a reference), so they only match whole words.
const SHORT_PATTERN: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: i64,
    pub field: String,
    #[serde(rename = "match")]
    pub match_kind: String,
    pub pattern: String,
    pub category_id: i64,
    pub category_name: String,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreview {
    pub matches: i64,
    pub uncategorised: i64,
    pub other_category: i64,
    pub whole_word: bool,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuleApplied {
    pub rule: Rule,
    pub applied: u64,
}

pub fn list_rules<S: Store>(store: &S) -> AppResult<Vec<Rule>> {
    Ok(store
        .rules_all()?
        .into_iter()
        .map(|r| Rule {
            id: r.id,
            field: r.field,
            match_kind: r.match_kind,
            pattern: r.pattern,
            category_id: r.category_id,
            category_name: r.category_name,
            priority: r.priority,
        })
        .collect())
}

/// A short "contains" text becomes a whole-word rule.
fn effective_match(pattern: &str, match_kind: &str, field: &str) -> String {
    if field == "iban" {
        return "contains".into();
    }
    if match_kind == "contains" && js_trim(pattern).encode_utf16().count() < SHORT_PATTERN {
        "word".into()
    } else {
        match_kind.into()
    }
}

fn text(r: &RuleTextRow) -> RuleText<'_> {
    RuleText {
        counterparty_name: r.counterparty_name.as_deref(),
        description: Some(&r.description),
        bank_counterparty: r.bank_counterparty.as_deref(),
        bank_description: r.bank_description.as_deref(),
        counterparty_iban: r.counterparty_iban.as_deref(),
    }
}

/// What a rule would do: how many transactions it matches and what it would change.
pub fn preview_rule<S: Store>(store: &S, field: &str, pattern: &str, match_kind: &str, category_id: Option<i64>) -> AppResult<RulePreview> {
    let effective = effective_match(pattern, match_kind, field);
    let pattern = js_trim(pattern);
    let rows = store.rule_texts(false)?;
    let hits: Vec<&RuleTextRow> = rows.iter().filter(|r| rule_matches(field, pattern, &effective, &text(r))).collect();
    let mut seen = HashSet::new();
    let examples = hits
        .iter()
        .map(|h| match h.counterparty_name.as_deref() {
            Some(n) if !n.is_empty() => n,
            _ => h.description.as_str(),
        })
        .filter(|e| seen.insert(*e))
        .take(3)
        .map(|e| slice_units(e, 60).to_owned())
        .collect();
    Ok(RulePreview {
        matches: hits.len() as i64,
        uncategorised: hits.iter().filter(|h| h.category_id.is_none()).count() as i64,
        other_category: hits.iter().filter(|h| h.category_id.is_some() && h.category_id != category_id).count() as i64,
        whole_word: field != "iban" && effective != match_kind,
        examples,
    })
}

/// Categorises the uncategorised transactions the rule matches.
fn apply_rule<S: Store>(store: &S, rule: &Rule) -> AppResult<u64> {
    let ids: Vec<i64> = store
        .rule_texts(true)?
        .iter()
        .filter(|r| rule_matches(&rule.field, &rule.pattern, &rule.match_kind, &text(r)))
        .map(|r| r.id)
        .collect();
    if ids.is_empty() {
        Ok(0)
    } else {
        categorize_transactions(store, &ids, Some(rule.category_id))
    }
}

fn duplicate(e: DbError) -> AppError {
    match e {
        DbError::Unique(_) => AppError::new("rules.duplicate", "A rule for this text already exists."),
        other => other.into(),
    }
}

fn find<S: Store>(store: &S, id: i64) -> AppResult<Option<Rule>> {
    Ok(list_rules(store)?.into_iter().find(|r| r.id == id))
}

pub fn create_rule<S: Store>(
    store: &S,
    field: &str,
    pattern: &str,
    match_kind: &str,
    category_id: i64,
    apply_to_existing: bool,
) -> AppResult<RuleApplied> {
    require_category(store, Some(category_id))?;
    let pattern = if field == "iban" { norm_iban(Some(pattern)) } else { js_trim(pattern).to_owned() };
    let id = store.rule_insert(field, &pattern, &effective_match(&pattern, match_kind, field), category_id).map_err(duplicate)?;
    let rule = find(store, id)?.ok_or_else(AppError::failed)?;
    let applied = if apply_to_existing { apply_rule(store, &rule)? } else { 0 };
    Ok(RuleApplied { rule, applied })
}

/// What `rules.update` changes; `None` keeps the rule's own value.
pub struct RuleChange<'a> {
    pub id: i64,
    pub field: Option<&'a str>,
    pub pattern: Option<&'a str>,
    pub match_kind: Option<&'a str>,
    pub category_id: Option<i64>,
    pub apply_to_existing: bool,
}

pub fn update_rule<S: Store>(store: &S, c: &RuleChange<'_>) -> AppResult<RuleApplied> {
    let old = find(store, c.id)?.ok_or_else(|| AppError::new("rules.not_found", "That rule no longer exists."))?;
    if c.category_id.is_some() {
        require_category(store, c.category_id)?;
    }
    let field = c.field.unwrap_or(&old.field);
    let pattern = match c.pattern {
        None => old.pattern.clone(),
        Some(p) if field == "iban" => norm_iban(Some(p)),
        Some(p) => js_trim(p).to_owned(),
    };
    let match_kind = effective_match(&pattern, c.match_kind.unwrap_or(&old.match_kind), field);
    store.rule_update(c.id, field, &pattern, &match_kind, c.category_id.unwrap_or(old.category_id)).map_err(duplicate)?;
    let rule = find(store, c.id)?.ok_or_else(AppError::failed)?;
    let applied = if c.apply_to_existing { apply_rule(store, &rule)? } else { 0 };
    Ok(RuleApplied { rule, applied })
}

/// Puts the rules in this order (first = checked first). Rules not listed keep their place after them.
pub fn reorder_rules<S: Store>(store: &S, ids: &[i64]) -> AppResult<Vec<Rule>> {
    store.transaction::<_, AppError, _>(|s| {
        let now = list_rules(s)?;
        let current: HashMap<i64, i64> = now.iter().map(|r| (r.id, r.priority)).collect();
        let order: Vec<i64> = ids.iter().copied().chain(now.iter().filter(|r| !ids.contains(&r.id)).map(|r| r.id)).collect();
        // Only rules whose place changed are written (each write is a change to sync).
        for (i, id) in order.iter().enumerate() {
            let priority = (order.len() - i) as i64;
            if current.get(id) != Some(&priority) {
                s.rule_set_priority(*id, priority)?;
            }
        }
        Ok(())
    })?;
    list_rules(store)
}

pub fn delete_rule<S: Store>(store: &S, id: i64) -> AppResult<()> {
    Ok(store.rule_delete(id)?)
}
