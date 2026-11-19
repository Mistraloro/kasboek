//! Payments that come back (subscriptions, rent, salary), found from the transactions themselves: the same payee at a
//! steady rhythm with a steady amount (src/core/recurring.ts).
use crate::core::Core;
use crate::dates::{add_days, add_months_to_date, day_diff, js_round};
use crate::error::{AppError, AppResult};
use crate::grouping::group_key;
use crate::jsstr::slice_units;
use kb_db::rows::RecurringRow;
use kb_db::Store;
use serde::Serialize;
use std::collections::HashMap;

/// `(frequency, days, months, items per month)`.
const RHYTHMS: [(&str, f64, i64, f64); 4] =
    [("weekly", 7.0, 0, 52.0 / 12.0), ("monthly", 30.4, 1, 1.0), ("quarterly", 91.0, 3, 1.0 / 3.0), ("yearly", 365.0, 12, 1.0 / 12.0)];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringItem {
    pub key: String,
    pub name: String,
    pub direction: &'static str,
    pub frequency: &'static str,
    pub typical_cents: i64,
    pub monthly_cents: i64,
    pub last_cents: i64,
    pub last_date: String,
    pub next_date: String,
    pub count: i64,
    pub status: &'static str,
    pub price_change_cents: Option<i64>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub account_id: i64,
    pub account_name: String,
    pub transaction_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringSummary {
    pub items: Vec<RecurringItem>,
    pub hidden: Vec<RecurringItem>,
    pub monthly_out_cents: i64,
    pub monthly_in_cents: i64,
    pub due_this_month_cents: i64,
}

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

/// The last result per database, valid while nothing in it changed (SQLite counts the rows this connection changed, so a
/// hidden mark shows at once) and for the same day.
pub fn find_recurring<S: Store>(core: &Core<S>, today: &str) -> AppResult<RecurringSummary> {
    let db = core.db()?;
    let key = format!("{today}|{}", db.total_changes()?);
    if let Some((kept, summary)) = &*core.recurring_cache.borrow() {
        if *kept == key {
            return Ok(summary.clone());
        }
    }
    let summary = scan_recurring(db, today)?;
    *core.recurring_cache.borrow_mut() = Some((key, summary.clone()));
    Ok(summary)
}

fn scan_recurring<S: Store>(db: &S, today: &str) -> AppResult<RecurringSummary> {
    let since = add_days(today, -430.0).ok_or_else(AppError::failed)?;
    let rows = db.recurring_rows(&since, today)?;
    let mut order: Vec<(String, Vec<&RecurringRow>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        // The payee as people read it; card payments without a payee by their (bank) description.
        let payee = r.counterparty_name.as_deref().filter(|n| !n.is_empty()).or(r.bank_counterparty.as_deref());
        let key = group_key(payee, &r.description, r.amount_cents);
        let at = *index.entry(key.clone()).or_insert_with(|| {
            order.push((key, Vec::new()));
            order.len() - 1
        });
        order[at].1.push(r);
    }
    let this_month = &today[..7];
    let mut items: Vec<RecurringItem> = Vec::new();
    for (key, list) in order {
        if list.len() < 2 {
            continue;
        }
        let gaps: Vec<f64> = list.windows(2).map(|w| day_diff(&w[0].booking_date, &w[1].booking_date)).filter(|g| *g > 0.0).collect();
        if gaps.is_empty() {
            continue;
        }
        let gap = median(&gaps);
        let Some(&(frequency, days, months, per_month)) = RHYTHMS.iter().find(|r| (gap - r.1).abs() <= r.1 * 0.2) else { continue };
        // Needs enough repeats for its rhythm, and most gaps close to it.
        if list.len() < if frequency == "yearly" { 2 } else { 3 } {
            continue;
        }
        let steady = gaps.iter().filter(|g| (**g - days).abs() <= days * 0.25).count() as f64 / gaps.len() as f64;
        if steady < 0.7 {
            continue;
        }
        let amounts: Vec<f64> = list.iter().map(|r| r.amount_cents as f64).collect();
        let usual = js_round(median(&amounts[amounts.len().saturating_sub(6)..]));
        let alike = amounts.iter().filter(|a| (**a - usual).abs() <= usual.abs() * 0.2).count() as f64 / amounts.len() as f64;
        if alike < 0.6 {
            continue;
        }
        let last = list[list.len() - 1];
        // After a price change the new price is what comes next (unless the last one was an outlier).
        let typical = if (last.amount_cents as f64 - usual).abs() <= usual.abs() * 0.2 { last.amount_cents } else { usual as i64 };
        let previous = list[list.len() - 2];
        let next = if months > 0 {
            add_months_to_date(&last.booking_date, months)
        } else {
            add_days(&last.booking_date, days).ok_or_else(AppError::failed)?
        };
        // Late: a few days past when it was expected, and still not seen.
        let grace = if frequency == "weekly" { 3.0 } else { 7.0 };
        let status = if last.booking_date.get(..7) == Some(this_month) && frequency != "weekly" {
            "paid"
        } else if next.as_str() < today && day_diff(&next, today) > grace {
            "late"
        } else if next.get(..7) == Some(this_month) {
            "due"
        } else {
            "later"
        };
        let moved = (last.amount_cents - previous.amount_cents).abs() as f64;
        let change = (last.amount_cents != previous.amount_cents && moved >= 100f64.max((previous.amount_cents.abs() as f64) * 0.02))
            .then_some(last.amount_cents - previous.amount_cents);
        let name = last
            .counterparty_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .or(last.bank_counterparty.as_deref().filter(|n| !n.is_empty()))
            .unwrap_or(&last.description);
        items.push(RecurringItem {
            key,
            name: slice_units(name, 60).to_owned(),
            direction: if typical < 0 { "out" } else { "in" },
            frequency,
            typical_cents: typical,
            monthly_cents: js_round(typical as f64 * per_month) as i64,
            last_cents: last.amount_cents,
            last_date: last.booking_date.clone(),
            next_date: next,
            count: list.len() as i64,
            status,
            price_change_cents: change,
            category_id: last.category_id,
            category_name: last.category_name.clone(),
            account_id: last.account_id,
            account_name: last.account_name.clone(),
            transaction_ids: list.iter().map(|r| r.id).collect(),
        });
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.monthly_cents.abs()));
    let hidden_keys = db.recurring_hidden_keys()?;
    let (hidden, counted): (Vec<_>, Vec<_>) = items.into_iter().partition(|i| hidden_keys.contains(&i.key));
    let out = |i: &&RecurringItem| i.direction == "out";
    Ok(RecurringSummary {
        monthly_out_cents: -counted.iter().filter(out).map(|i| i.monthly_cents).sum::<i64>(),
        monthly_in_cents: counted.iter().filter(|i| i.direction == "in").map(|i| i.monthly_cents).sum(),
        due_this_month_cents: -counted
            .iter()
            .filter(out)
            .filter(|i| i.status == "due" || i.status == "late")
            .map(|i| i.typical_cents)
            .sum::<i64>(),
        items: counted,
        hidden,
    })
}

/// Stops counting a detected item (or counts it again). Only items that are detected now can be hidden, so a made-up key
/// does nothing. A mark is never deleted: for sync a deleted row stays deleted on every computer, so showing again sets
/// `hidden` back to 0 instead.
pub fn set_recurring_hidden<S: Store>(core: &Core<S>, key: &str, hidden: bool, today: &str) -> AppResult<RecurringSummary> {
    let db = core.db()?;
    if hidden {
        let found = find_recurring(core, today)?;
        if !found.items.iter().chain(&found.hidden).any(|i| i.key == key) {
            return Err(AppError::new("recurring.not_found", "That fixed cost is not (or no longer) found."));
        }
    } else if !db.recurring_mark_exists(key)? {
        return find_recurring(core, today);
    }
    db.recurring_mark_set(key, hidden)?;
    find_recurring(core, today)
}
