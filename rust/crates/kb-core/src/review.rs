//! The facts for a monthly review (src/core/review.ts): categories against the three months before, budgets that went
//! over, payments that stand out.
use crate::budgets::{list_budgets, month_summary, MonthSummary};
use crate::dates::{add_months, js_round};
use crate::error::AppResult;
use crate::finance::{main_currency, month_range};
use crate::grouping::group_key;
use crate::jsstr::slice_units;
use kb_db::Store;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTrend {
    pub category_id: Option<i64>,
    pub name: String,
    pub cents: f64,
    pub average_cents: f64,
    pub change_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverBudget {
    pub category_id: i64,
    pub name: String,
    pub budget_cents: i64,
    pub spent_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unusual {
    pub id: i64,
    pub date: String,
    pub name: String,
    pub cents: f64,
    pub usual_cents: Option<f64>,
    pub category: Option<String>,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthReview {
    pub month: String,
    pub income_cents: f64,
    pub spending_cents: f64,
    pub average_income_cents: f64,
    pub average_spending_cents: f64,
    pub uncategorised: i64,
    pub categories: Vec<CategoryTrend>,
    pub over_budget: Vec<OverBudget>,
    pub unusual: Vec<Unusual>,
}

fn months_before<S: Store>(store: &S, month: &str) -> AppResult<Vec<MonthSummary>> {
    (1..=3).map(|n| month_summary(store, &add_months(month, -n))).collect()
}

/// Each spending category of the month against its average of the three months before, the biggest change first (top 15).
fn category_trend(now: &MonthSummary, before: &[MonthSummary]) -> Vec<CategoryTrend> {
    let mut names: HashMap<Option<i64>, &str> = HashMap::new();
    let mut ids: Vec<Option<i64>> = Vec::new();
    let mut seen = HashSet::new();
    for s in std::iter::once(now).chain(before) {
        for c in &s.by_category {
            names.insert(c.category_id, &c.name);
            if seen.insert(c.category_id) {
                ids.push(c.category_id);
            }
        }
    }
    let spent = |s: &MonthSummary, id: Option<i64>| s.by_category.iter().find(|c| c.category_id == id).map_or(0.0, |c| c.cents);
    let mut out: Vec<CategoryTrend> = ids
        .into_iter()
        .map(|id| {
            let cents = spent(now, id);
            let average = js_round(before.iter().map(|m| spent(m, id)).sum::<f64>() / before.len() as f64);
            CategoryTrend {
                category_id: id,
                name: names.get(&id).copied().unwrap_or("").to_owned(),
                cents,
                average_cents: average,
                change_cents: cents - average,
            }
        })
        .filter(|c| c.cents != 0.0 || c.average_cents != 0.0)
        .collect();
    out.sort_by(|a, b| b.change_cents.abs().total_cmp(&a.change_cents.abs()));
    out.truncate(15);
    out
}

/// `categoryTrend(db, month)` of src/core/review.ts: the trend of one month without the rest of the review.
pub fn category_trend_of<S: Store>(store: &S, month: &str) -> AppResult<Vec<CategoryTrend>> {
    Ok(category_trend(&month_summary(store, month)?, &months_before(store, month)?))
}

pub fn month_review<S: Store>(store: &S, month: &str) -> AppResult<MonthReview> {
    let main = main_currency(store)?;
    let now = month_summary(store, month)?;
    let before = months_before(store, month)?;
    let avg = |pick: fn(&MonthSummary) -> f64| js_round(before.iter().map(pick).sum::<f64>() / before.len() as f64);
    let categories = category_trend(&now, &before);
    let over_budget = list_budgets(store, month)?
        .into_iter()
        .filter_map(|b| match b.budget_cents {
            Some(budget) if b.spent_cents > budget as f64 => {
                Some(OverBudget { category_id: b.category_id, name: b.name, budget_cents: budget, spent_cents: b.spent_cents })
            }
            _ => None,
        })
        .collect();

    // Payments that stand out: far above what this payee usually costs, or a large first payment.
    let (from, to) = month_range(month);
    let (history_from, _) = month_range(&add_months(month, -12));
    let rows = store.review_rows(&main, &history_from, &to)?;
    let mut earlier: HashMap<String, Vec<f64>> = HashMap::new();
    let mut this_month = Vec::new();
    for t in &rows {
        if t.booking_date >= from {
            this_month.push(t);
        } else {
            earlier.entry(group_key(t.counterparty_name.as_deref(), &t.description, t.amount_cents)).or_default().push(-t.main);
        }
    }
    let mut outs: Vec<f64> = this_month.iter().map(|t| -t.main).collect();
    outs.sort_by(f64::total_cmp);
    let large = if outs.is_empty() { 0.0 } else { outs[(outs.len() as f64 * 0.9).floor() as usize] };
    let mut unusual: Vec<Unusual> = this_month
        .iter()
        .filter_map(|t| {
            let mut past =
                earlier.get(&group_key(t.counterparty_name.as_deref(), &t.description, t.amount_cents)).cloned().unwrap_or_default();
            past.sort_by(f64::total_cmp);
            let usual = past.get(past.len() >> 1).copied();
            let cents = -t.main;
            let reason = match usual {
                Some(u) if past.len() >= 2 && cents > u * 2.5 && cents - u >= 2000.0 => "higher",
                None if cents >= large.max(5000.0) => "new",
                _ => return None,
            };
            let name = match t.counterparty_name.as_deref() {
                Some(n) if !n.is_empty() => n,
                _ => &t.description,
            };
            Some(Unusual {
                id: t.id,
                date: t.booking_date.clone(),
                name: slice_units(name, 60).to_owned(),
                cents,
                usual_cents: usual,
                category: t.category_name.clone(),
                reason,
            })
        })
        .collect();
    unusual.sort_by(|a, b| b.cents.total_cmp(&a.cents));
    unusual.truncate(8);
    Ok(MonthReview {
        month: month.to_owned(),
        income_cents: now.income_cents,
        spending_cents: now.spending_cents,
        average_income_cents: avg(|s| s.income_cents),
        average_spending_cents: avg(|s| s.spending_cents),
        uncategorised: now.uncategorized,
        categories,
        over_budget,
        unusual,
    })
}
