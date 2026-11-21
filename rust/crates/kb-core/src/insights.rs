//! Tips for the Overview, found locally from the person's own data (src/core/insights.ts): price rises, a payment taken twice,
//! late or upcoming fixed costs, budgets, categories that grew, unusual payments. No model and nothing is sent anywhere: this
//! only builds facts. Every money value carries its currency; a fact that mixes currencies is worked out in the main currency
//! and left out when a rate is missing. Income is never a fact. What the person hid is kept in `insight_feedback`.
use crate::alerts::list_alerts;
use crate::budgets::list_budgets;
use crate::core::Core;
use crate::dates::{add_days, add_months, day_diff, js_round};
use crate::error::{AppError, AppResult};
use crate::finance::main_currency;
use crate::insight_plan::preset_for;
use crate::numbers::js_number;
use crate::recurring::{find_recurring, RecurringItem};
use crate::review::{category_trend_of, month_review};
use crate::settings::get_settings;
use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use kb_db::queries::insights::PaymentRow;
use kb_db::Store;
use kb_rules::mask::mask_private;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Limits for the first version. Amounts are cents, shares are fractions.
mod limit {
    /// At most this many facts, the biggest first.
    pub const MAX_FACTS: usize = 30;
    pub const MAX_TRANSACTION_IDS: usize = 20;
    /// A price rise counts while the last payment is at most this many days ago.
    pub const PRICE_UP_DAYS: f64 = 60.0;
    /// A payment taken twice: both within this share of the usual amount, in the last days.
    pub const CHARGED_TWICE_SHARE: f64 = 0.1;
    pub const CHARGED_TWICE_DAYS: f64 = 60.0;
    /// A cost due within this many days, when it is quarterly or yearly or this many times the median fixed cost.
    pub const UPCOMING_DAYS: f64 = 30.0;
    pub const UPCOMING_TIMES_MEDIAN: f64 = 2.0;
    /// A category up by this share and this amount against the average of the three months before.
    pub const CATEGORY_UP_SHARE: f64 = 0.25;
    pub const CATEGORY_UP_CENTS: f64 = 5000.0;
    /// A category without a budget that took this much a month on average in each of the last months.
    pub const NO_BUDGET_MONTHS: i64 = 3;
    pub const NO_BUDGET_CENTS: f64 = 10000.0;
    /// The summary of fixed costs needs at least this many.
    pub const SUBSCRIPTIONS_MIN: usize = 2;
}

/// A budget is nearly used up from this share of it (`NEAR` of src/core/alerts.ts).
const NEAR: f64 = 0.8;

/// `String.prototype.localeCompare` as Node runs it with the default locale: the Unicode root collation at tertiary strength
/// (punctuation before digits before letters, lowercase before uppercase for equal letters, accents after the base letter).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| Collator::try_new(Default::default(), CollatorOptions::default()).expect("the root collation is compiled in"))
        .compare(a, b)
}

/// `InsightValue`.
#[derive(Debug, Clone, PartialEq)]
pub enum InsightValue {
    Money { money: f64, currency: String },
    Date(String),
    Count(f64),
    Text(String),
}

impl InsightValue {
    fn to_json(&self) -> Value {
        match self {
            Self::Money { money, currency } => json!({ "money": js_number(*money), "currency": currency }),
            Self::Date(date) => json!({ "date": date }),
            Self::Count(count) => json!({ "count": js_number(*count) }),
            Self::Text(text) => json!({ "text": text }),
        }
    }
}

/// A fact found from the person's own data. The tip texts are made from these on screen. `values` keeps the order the fields
/// were added in.
#[derive(Debug, Clone, PartialEq)]
pub struct InsightFact {
    pub id: String,
    /// Stable for the same situation (same payee and month, same category and month), so a hidden tip stays hidden.
    pub key: String,
    pub kind: &'static str,
    pub values: Vec<(String, InsightValue)>,
    pub category_id: Option<i64>,
    pub recurring_key: Option<String>,
    /// The payments behind it (at most 20).
    pub transaction_ids: Vec<i64>,
    /// How much money it is about, in cents of the main currency: the biggest come first.
    pub weight: f64,
}

impl InsightFact {
    pub fn to_json(&self) -> Value {
        let values: Map<String, Value> = self.values.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
        json!({
            "id": self.id, "key": self.key, "kind": self.kind, "values": values, "categoryId": self.category_id,
            "recurringKey": self.recurring_key, "transactionIds": self.transaction_ids, "weight": js_number(self.weight)
        })
    }
}

fn days_between(from: &str, to: &str) -> f64 {
    js_round(day_diff(from, to))
}

/// The latest calendar month in the last days with two payments near the usual amount of a monthly fixed cost.
fn charged_twice(recent: &HashMap<i64, PaymentRow>, item: &RecurringItem) -> Option<(String, Vec<PaymentRow>)> {
    let usual = item.typical_cents.abs() as f64;
    let mut rows: Vec<&PaymentRow> = item.transaction_ids.iter().filter_map(|id| recent.get(id)).collect();
    rows.sort_by(|a, b| locale_compare(&a.booking_date, &b.booking_date).then(a.id.cmp(&b.id)));
    let mut by_month: Vec<(String, Vec<PaymentRow>)> = Vec::new();
    for r in rows {
        if ((r.amount_cents.abs() as f64) - usual).abs() > usual * limit::CHARGED_TWICE_SHARE {
            continue;
        }
        let m = r.booking_date.get(..7).unwrap_or(&r.booking_date);
        match by_month.iter_mut().find(|(month, _)| month == m) {
            Some((_, list)) => list.push(r.clone()),
            None => by_month.push((m.to_owned(), vec![r.clone()])),
        }
    }
    by_month.into_iter().rfind(|(_, list)| list.len() >= 2)
}

/// `median` of src/core/recurring.ts.
fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(f64::total_cmp);
    let m = s.len() >> 1;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}

/// The keys of the tips the person hid or called not useful.
pub fn dismissed_keys<S: Store>(store: &S) -> AppResult<HashSet<String>> {
    Ok(store.insights_dismissed_keys()?.into_iter().collect())
}

/// Facts for `month` ('YYYY-MM'): the biggest first, without the ones the person hid. Where the TypeScript keeps the facts
/// of the last call while nothing changed, this works them out each time: the same answer.
pub fn build_facts<S: Store>(core: &Core<S>, month: &str, today: &str) -> AppResult<Vec<InsightFact>> {
    let mut drafts = draft_facts(core, month, today)?;
    let hidden = dismissed_keys(core.db()?)?;
    drafts.retain(|d| !hidden.contains(&d.key));
    drafts.sort_by(|a, b| {
        let d = b.weight - a.weight;
        if d < 0.0 {
            Ordering::Less
        } else if d > 0.0 {
            Ordering::Greater
        } else {
            locale_compare(&a.key, &b.key)
        }
    });
    drafts.truncate(limit::MAX_FACTS);
    for (n, d) in drafts.iter_mut().enumerate() {
        d.id = format!("f{}", n + 1);
    }
    Ok(drafts)
}

/// Collects the drafts: `add` of the TypeScript.
struct Drafts(Vec<InsightFact>);

type Fields = Vec<(&'static str, InsightValue)>;

#[derive(Default)]
struct Extra {
    category_id: Option<i64>,
    recurring_key: Option<String>,
    transaction_ids: Vec<i64>,
}

impl Drafts {
    fn add(&mut self, kind: &'static str, key: &str, values: Fields, weight: f64, extra: Extra) {
        let mut ids = extra.transaction_ids;
        ids.truncate(limit::MAX_TRANSACTION_IDS);
        self.0.push(InsightFact {
            id: String::new(),
            key: format!("{kind}:{key}"),
            kind,
            values: values.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
            category_id: extra.category_id,
            recurring_key: extra.recurring_key,
            transaction_ids: ids,
            weight: js_round(weight).max(0.0),
        });
    }
}

fn text(s: impl Into<String>) -> InsightValue {
    InsightValue::Text(s.into())
}

fn money(cents: f64, currency: &str) -> InsightValue {
    InsightValue::Money { money: cents, currency: currency.to_owned() }
}

fn count(n: f64) -> InsightValue {
    InsightValue::Count(n)
}

fn date(d: &str) -> InsightValue {
    InsightValue::Date(d.to_owned())
}

fn draft_facts<S: Store>(core: &Core<S>, month: &str, today: &str) -> AppResult<Vec<InsightFact>> {
    let db = core.db()?;
    let main = main_currency(db)?;
    let current_month = today.get(..7).ok_or_else(AppError::failed)?;
    let currency_of: HashMap<i64, String> = db.insights_account_currencies()?.into_iter().collect();
    let in_main = |cents: f64, currency: &str| -> AppResult<Option<f64>> { Ok(db.fx_convert(cents, currency, today, &main)?) };
    let mut drafts = Drafts(Vec::new());

    // Fixed costs and the balance warning are about now: only for the month that is running.
    if month == current_month {
        let costs: Vec<RecurringItem> = find_recurring(core, today)?.items.into_iter().filter(|i| i.direction == "out").collect();
        let since = add_days(today, -limit::CHARGED_TWICE_DAYS).ok_or_else(AppError::failed)?;
        let recent: HashMap<i64, PaymentRow> = db.insights_recent_payments(&since, today)?.into_iter().map(|r| (r.id, r)).collect();
        let currency = |i: &RecurringItem| currency_of.get(&i.account_id).cloned().unwrap_or_else(|| main.clone());
        let weight_of = |i: &RecurringItem, cents: i64| -> AppResult<f64> { Ok(in_main(cents.abs() as f64, &currency(i))?.unwrap_or(0.0)) };
        let mut amounts = Vec::new();
        for i in &costs {
            if let Some(v) = in_main(i.typical_cents.abs() as f64, &currency(i))? {
                amounts.push(v);
            }
        }
        let usual_cost = (!amounts.is_empty()).then(|| median(&amounts));

        for i in &costs {
            let cur = currency(i);
            let base = || Extra {
                category_id: None,
                recurring_key: Some(i.key.clone()),
                transaction_ids: i.transaction_ids[i.transaction_ids.len().saturating_sub(limit::MAX_TRANSACTION_IDS)..].to_vec(),
            };
            let name = || ("name", text(mask_private(&i.name, None)));
            // More expensive than the payment before (money out is negative, so a rise is below zero).
            if let Some(change) = i.price_change_cents.filter(|c| *c < 0) {
                if days_between(&i.last_date, today) <= limit::PRICE_UP_DAYS {
                    drafts.add(
                        "price_up",
                        &format!("{}:{}", i.key, i.last_date.get(..7).unwrap_or(&i.last_date)),
                        vec![
                            name(),
                            ("from", money((i.last_cents - change).abs() as f64, &cur)),
                            ("to", money(i.last_cents.abs() as f64, &cur)),
                            ("change", money(change.abs() as f64, &cur)),
                            ("date", date(&i.last_date)),
                        ],
                        weight_of(i, change)?,
                        base(),
                    );
                }
            }
            if i.status == "late" {
                drafts.add(
                    "late",
                    &format!("{}:{}", i.key, i.next_date),
                    vec![name(), ("amount", money(i.typical_cents.abs() as f64, &cur)), ("date", date(&i.next_date))],
                    weight_of(i, i.typical_cents)?,
                    base(),
                );
            }
            let in_days = days_between(today, &i.next_date);
            let big = match usual_cost {
                Some(usual) => in_main(i.typical_cents.abs() as f64, &cur)?.unwrap_or(0.0) >= usual * limit::UPCOMING_TIMES_MEDIAN,
                None => false,
            };
            if (0.0..=limit::UPCOMING_DAYS).contains(&in_days) && (i.frequency == "quarterly" || i.frequency == "yearly" || big) {
                drafts.add(
                    "upcoming",
                    &format!("{}:{}", i.key, i.next_date),
                    vec![name(), ("amount", money(i.typical_cents.abs() as f64, &cur)), ("date", date(&i.next_date))],
                    weight_of(i, i.typical_cents)?,
                    base(),
                );
            }
            if i.frequency == "monthly" {
                if let Some((twice_month, list)) = charged_twice(&recent, i) {
                    let last = list.last().ok_or_else(AppError::failed)?;
                    drafts.add(
                        "charged_twice",
                        &format!("{}:{twice_month}", i.key),
                        vec![
                            name(),
                            ("amount", money(last.amount_cents.abs() as f64, &cur)),
                            ("count", count(list.len() as f64)),
                            ("date", date(&last.booking_date)),
                        ],
                        weight_of(i, last.amount_cents)?,
                        Extra {
                            category_id: None,
                            recurring_key: Some(i.key.clone()),
                            transaction_ids: list.iter().map(|r| r.id).collect(),
                        },
                    );
                }
            }
        }

        // Fixed costs together (a later step can look for overlaps), in the main currency.
        let mut converted: Vec<(String, f64)> = Vec::new();
        for i in &costs {
            if let Some(v) = in_main(i.monthly_cents.abs() as f64, &currency(i))? {
                converted.push((mask_private(&i.name, None), v));
            }
        }
        if converted.len() >= limit::SUBSCRIPTIONS_MIN {
            let total: f64 = converted.iter().fold(0.0, |t, c| t + c.1);
            converted.sort_by(|a, b| b.1.total_cmp(&a.1));
            let names = converted.iter().map(|c| c.0.as_str()).collect::<Vec<_>>().join(", ");
            drafts.add(
                "subscriptions",
                month,
                vec![("count", count(converted.len() as f64)), ("amount", money(total, &main)), ("names", text(names))],
                total,
                Extra::default(),
            );
        }

        for a in list_alerts(core, today)? {
            if a["kind"] != "balance" {
                continue;
            }
            let (account_id, until, cur) =
                (a["accountId"].as_i64().unwrap_or(0), a["until"].as_str().unwrap_or(""), a["currency"].as_str().unwrap_or(""));
            let cents = |field: &str| a[field].as_f64().unwrap_or(0.0);
            drafts.add(
                "balance_low",
                &format!("{account_id}:{until}"),
                vec![
                    ("name", text(a["name"].as_str().unwrap_or(""))),
                    ("lowest", money(cents("lowestCents"), cur)),
                    ("balance", money(cents("balanceCents"), cur)),
                    ("due", money(cents("dueCents"), cur)),
                    ("date", date(until)),
                ],
                in_main(cents("lowestCents").abs(), cur)?.unwrap_or(0.0),
                Extra::default(),
            );
        }
    }

    // Budgets of the month (the same limits as the warnings).
    let budgets = list_budgets(db, month)?;
    for b in &budgets {
        let Some(budget) = b.budget_cents.filter(|c| *c > 0) else { continue };
        let budget = budget as f64;
        if b.spent_cents < budget * NEAR {
            continue;
        }
        let kind = if b.spent_cents > budget { "over_budget" } else { "near_budget" };
        drafts.add(
            kind,
            &format!("{month}:{}", b.category_id),
            vec![
                ("name", text(&b.name)),
                ("spent", money(b.spent_cents, &main)),
                ("budget", money(budget, &main)),
                ("percent", count(js_round(b.spent_cents / budget * 100.0))),
                ("month", text(month)),
            ],
            b.spent_cents,
            Extra { category_id: Some(b.category_id), ..Extra::default() },
        );
    }

    // A category with steady spending and no budget.
    let earlier = (0..limit::NO_BUDGET_MONTHS).map(|n| list_budgets(db, &add_months(month, -(n + 1)))).collect::<AppResult<Vec<_>>>()?;
    for b in &budgets {
        if b.budget_cents.is_some() {
            continue;
        }
        let spent: Vec<f64> =
            earlier.iter().map(|rows| rows.iter().find(|r| r.category_id == b.category_id).map_or(0.0, |r| r.spent_cents)).collect();
        let average = spent.iter().fold(0.0, |t, c| t + c) / spent.len() as f64;
        if spent.iter().all(|c| *c > 0.0) && average >= limit::NO_BUDGET_CENTS {
            drafts.add(
                "no_budget",
                &format!("{month}:{}", b.category_id),
                vec![("name", text(&b.name)), ("average", money(js_round(average), &main)), ("month", text(month))],
                average,
                Extra { category_id: Some(b.category_id), ..Extra::default() },
            );
        }
    }

    // Against the three months before, only for a finished month: the one shown, or else the month before.
    let finished = if month < current_month { month.to_owned() } else { add_months(current_month, -1) };
    // The full review is only needed for the month shown (payments that stand out); the month before needs the category totals only.
    let shown = month_review(db, month)?;
    let trend = if finished == month { shown.categories.clone() } else { category_trend_of(db, &finished)? };
    for c in &trend {
        let Some(category_id) = c.category_id else { continue };
        if c.average_cents <= 0.0
            || c.change_cents < c.average_cents * limit::CATEGORY_UP_SHARE
            || c.change_cents < limit::CATEGORY_UP_CENTS
        {
            continue;
        }
        drafts.add(
            "category_up",
            &format!("{finished}:{category_id}"),
            vec![
                ("name", text(&c.name)),
                ("amount", money(c.cents, &main)),
                ("average", money(c.average_cents, &main)),
                ("change", money(c.change_cents, &main)),
                ("percent", count(js_round(c.change_cents / c.average_cents * 100.0))),
                ("month", text(&finished)),
            ],
            c.change_cents,
            Extra { category_id: Some(category_id), ..Extra::default() },
        );
    }

    // Payments that stand out in the month shown.
    for u in &shown.unusual {
        let mut values = vec![("name", text(mask_private(&u.name, None))), ("amount", money(u.cents, &main))];
        if let Some(usual) = u.usual_cents {
            values.push(("usual", money(usual, &main)));
        }
        values.push(("date", date(&u.date)));
        values.push(("reason", text(u.reason)));
        drafts.add("unusual", &u.id.to_string(), values, u.cents, Extra { transaction_ids: vec![u.id], ..Extra::default() });
    }

    Ok(drafts.0)
}

/// `Object.entries` order of a parsed JSON object: keys that are array indexes first, ascending, then the others as they came.
fn js_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |k: &str| -> Option<u32> {
        let canonical = k == "0" || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()));
        canonical.then(|| k.parse::<u32>().ok().filter(|n| *n < u32::MAX)).flatten()
    };
    let mut indexed: Vec<(u32, (&String, &Value))> = map.iter().filter_map(|e| index(e.0).map(|n| (n, e))).collect();
    indexed.sort_by_key(|(n, _)| *n);
    indexed.into_iter().map(|(_, e)| e).chain(map.iter().filter(|(k, _)| index(k).is_none())).collect()
}

/// `JSON.stringify` of a parsed value: numbers as JavaScript prints them and integer-like keys first.
fn js_stringify(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(x) if n.is_f64() => out.push_str(&js_number(x).to_string()),
            _ => out.push_str(&n.to_string()),
        },
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                js_stringify(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (n, (k, item)) in js_entries(map).into_iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                js_stringify(item, out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// A short hash of what the facts say (keys and values; not the ids and not the day), to know whether anything changed since
/// tips were last written from them. The facts are JSON as stored (`InsightFact::to_json` for fresh ones).
pub fn hash_facts(facts: &[Value]) -> AppResult<String> {
    let mut sorted: Vec<(&str, &Value)> = Vec::with_capacity(facts.len());
    for f in facts {
        sorted.push((f["key"].as_str().ok_or_else(AppError::failed)?, f));
    }
    sorted.sort_by(|a, b| locale_compare(a.0, b.0));
    let mut stable = Vec::with_capacity(sorted.len());
    for (key, f) in sorted {
        let Some(values) = f["values"].as_object() else { return Err(AppError::failed()) };
        let mut entries = js_entries(values);
        entries.sort_by(|a, b| locale_compare(a.0, b.0));
        let entries: Vec<Value> = entries.into_iter().map(|(k, v)| json!([k, v])).collect();
        stable.push(json!([key, f["kind"], entries]));
    }
    let mut text = String::new();
    js_stringify(&Value::Array(stable), &mut text);
    let digest = Sha256::digest(text.as_bytes());
    Ok(hex::encode(digest)[..32].to_owned())
}

/// What the person did with a tip. Hidden and "not useful" tips are left out from then on.
pub fn give_feedback<S: Store>(store: &S, key: &str, verdict: &str) -> AppResult<()> {
    Ok(store.insights_feedback_set(key, verdict)?)
}

/// Brings back the hidden and "not useful" tips; returns how many.
pub fn restore_dismissed<S: Store>(store: &S) -> AppResult<u64> {
    Ok(store.insights_restore_dismissed()?)
}

fn array_of(json: &str) -> Option<Vec<Value>> {
    match serde_json::from_str(json) {
        Ok(Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// The local facts for a month and, when the assistant wrote tips for it, those tips: without what the person hid since, and
/// marked when the facts or the interface language are not the ones they were written for (`language` None: not known here, so
/// only the facts are compared).
pub fn insights_view<S: Store>(core: &Core<S>, month: &str, language: Option<&str>, today: &str) -> AppResult<Value> {
    let db = core.db()?;
    let facts = build_facts(core, month, today)?;
    let shown: Vec<Value> = facts.iter().map(InsightFact::to_json).collect();
    let Some(row) = db.insights_row(month)? else { return Ok(json!({ "facts": shown, "ai": null })) };
    let (Some(sent), Some(suggestions)) = (array_of(&row.facts_json), array_of(&row.suggestions_json)) else {
        return Ok(json!({ "facts": shown, "ai": null }));
    };
    let hidden = dismissed_keys(db)?;
    let now = hash_facts(&shown)?;
    // What was hidden after the tips were written is no change in the data.
    let kept: Vec<Value> = sent.iter().filter(|f| !f["key"].as_str().is_some_and(|k| hidden.contains(k))).cloned().collect();
    let same_data = now == row.facts_hash || now == hash_facts(&kept)?;
    let stale = if !same_data {
        json!("data")
    } else if language.is_some_and(|l| row.language != l) {
        json!("language")
    } else {
        Value::Null
    };
    let settings = get_settings(db)?;
    let name = settings.get("aiProviders").and_then(|p| p.get(&row.provider)).and_then(|p| p.get("name")).and_then(Value::as_str);
    let mut visible = Vec::with_capacity(suggestions.len());
    for s in suggestions {
        let keys = s["factKeys"].as_array().ok_or_else(AppError::failed)?;
        if !keys.iter().any(|k| k.as_str().is_some_and(|k| hidden.contains(k))) {
            visible.push(s);
        }
    }
    Ok(json!({
        "facts": shown,
        "ai": {
            "createdAt": row.created_at,
            "providerName": preset_for(&row.provider, name).assistant_name,
            "model": row.model,
            "language": row.language,
            "stale": stale,
            "suggestions": visible,
            "facts": sent
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_compare_orders_like_icu() {
        // Punctuation before digits before letters; lowercase before uppercase for equal letters; accents after the base letter.
        let sorted = ["_", "-", "1", "10", "2", "a", "A", "á", "b", "B"];
        for pair in sorted.windows(2) {
            assert_eq!(locale_compare(pair[0], pair[1]), Ordering::Less, "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(locale_compare("a", "a"), Ordering::Equal);
    }

    #[test]
    fn index_keys_come_first() {
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4,"01":5}"#).unwrap();
        let mut out = String::new();
        js_stringify(&v, &mut out);
        assert_eq!(out, r#"{"1":4,"2":2,"b":1,"a":3,"01":5}"#);
    }

    #[test]
    fn numbers_print_like_javascript() {
        let mut out = String::new();
        js_stringify(&json!([100.0, -0.0, 2.5, 7]), &mut out);
        assert_eq!(out, "[100,0,2.5,7]");
    }
}
