//! Warnings: a budget at 80% or more this month, and an account whose balance would go below zero before the next income
//! (src/core/alerts.ts).
use crate::balance::current_balance;
use crate::budgets::list_budgets;
use crate::core::Core;
use crate::dates::end_of_month;
use crate::error::AppResult;
use crate::recurring::find_recurring;
use kb_db::Store;
use serde_json::{json, Value};

/// A budget is nearly used up from this share of it.
const NEAR: f64 = 0.8;

pub fn list_alerts<S: Store>(core: &Core<S>, today: &str) -> AppResult<Vec<Value>> {
    let db = core.db()?;
    let month = &today[..7];
    let mut alerts = Vec::new();
    for b in list_budgets(db, month)? {
        let Some(budget) = b.budget_cents.filter(|c| *c > 0) else { continue };
        if b.spent_cents < budget as f64 * NEAR {
            continue;
        }
        let level = if b.spent_cents > budget as f64 { "over" } else { "near" };
        alerts.push(json!({
            "kind": "budget", "key": format!("budget:{month}:{}:{level}", b.category_id), "categoryId": b.category_id, "name": b.name,
            "budgetCents": budget, "spentCents": b.spent_cents, "level": level
        }));
    }

    // Balances: only for accounts whose balance is known (a bank balance was recorded, or a start).
    let recurring = find_recurring(core, today)?.items;
    for (id, name, currency) in db.alert_accounts()? {
        let income = recurring
            .iter()
            .filter(|r| r.direction == "in" && r.account_id == id && r.next_date.as_str() >= today)
            .min_by(|x, y| x.next_date.cmp(&y.next_date));
        let until = income.map_or_else(|| end_of_month(today), |i| i.next_date.clone());
        // Fixed costs on this account still to come before then (late ones too: not paid yet).
        let due_cents: i64 = recurring
            .iter()
            .filter(|r| {
                r.direction == "out"
                    && r.account_id == id
                    && (r.status == "late" || (r.next_date.as_str() >= today && r.next_date <= until))
            })
            .map(|r| r.typical_cents)
            .sum();
        let balance = current_balance(db, id)?;
        let lowest = balance + due_cents as f64;
        if lowest < 0.0 {
            alerts.push(json!({
                "kind": "balance", "key": format!("balance:{id}:{until}"), "accountId": id, "name": name, "currency": currency,
                "balanceCents": balance, "lowestCents": lowest, "until": until, "dueCents": -due_cents
            }));
        }
    }
    Ok(alerts)
}
