//! Savings goals (src/core/goals.ts): an amount by a date, tracked by an account's balance or kept by hand.
use crate::balance::current_balance;
use crate::error::{AppError, AppResult};
use crate::finance::main_currency;
use kb_db::rows::GoalWrite;
use kb_db::Store;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: i64,
    pub name: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub saved_cents: Option<i64>,
    pub current_cents: f64,
    pub remaining_cents: f64,
    pub reached: bool,
    pub per_month_cents: Option<f64>,
    pub overdue: bool,
    pub archived: bool,
}

/// `[year, month, day]` of a `YYYY-MM-DD` text.
fn ymd(date: &str) -> [i64; 3] {
    let mut parts = date.split('-').map(|p| p.parse::<i64>().unwrap_or(0));
    [parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0)]
}

/// Whole months from today to the date, at least 1.
fn months_until(today: &str, date: &str) -> i64 {
    let [y1, m1, d1] = ymd(today);
    let [y2, m2, d2] = ymd(date);
    ((y2 - y1) * 12 + (m2 - m1) + if d2 >= d1 { 0 } else { -1 }).max(1)
}

pub fn list_goals<S: Store>(store: &S, today: &str) -> AppResult<Vec<Goal>> {
    let main = main_currency(store)?;
    let mut out = Vec::new();
    for r in store.goals_all()? {
        // In the main currency: an account in another currency is converted at today's rate.
        let current = match r.account_id {
            Some(id) => {
                let balance = current_balance(store, id)?;
                store.fx_convert(balance, r.account_currency.as_deref().unwrap_or(&main), today, &main)?.unwrap_or(0.0)
            }
            None => r.saved_cents.unwrap_or(0) as f64,
        };
        let remaining = (r.target_cents as f64 - current).max(0.0);
        let overdue = r.target_date.as_deref().is_some_and(|d| d < today);
        let per_month = match r.target_date.as_deref() {
            Some(date) if remaining > 0.0 && !overdue => Some((remaining / months_until(today, date) as f64).ceil()),
            _ => None,
        };
        out.push(Goal {
            id: r.id,
            name: r.name,
            target_cents: r.target_cents,
            target_date: r.target_date,
            account_id: r.account_id,
            account_name: r.account_name,
            saved_cents: r.saved_cents,
            current_cents: current,
            remaining_cents: remaining,
            reached: remaining == 0.0,
            per_month_cents: per_month,
            overdue: overdue && remaining > 0.0,
            archived: r.archived,
        });
    }
    Ok(out)
}

fn check<S: Store>(store: &S, account_id: Option<i64>) -> AppResult<()> {
    match account_id {
        Some(id) if store.account_get(id)?.is_none() => Err(AppError::new("accounts.not_found", "Account not found.")),
        _ => Ok(()),
    }
}

pub struct NewGoal {
    pub name: String,
    pub target_cents: i64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub saved_cents: Option<i64>,
}

pub fn create_goal<S: Store>(store: &S, g: &NewGoal, today: &str) -> AppResult<Vec<Goal>> {
    check(store, g.account_id)?;
    store.goal_insert(
        &g.name,
        g.target_cents,
        g.target_date.as_deref(),
        g.account_id,
        if g.account_id.is_some() { None } else { Some(g.saved_cents.unwrap_or(0)) },
    )?;
    list_goals(store, today)
}

/// A change to a goal; `None` leaves a field as it is, `Some(None)` clears a nullable one.
pub struct GoalChange {
    pub id: i64,
    pub name: Option<String>,
    pub target_cents: Option<i64>,
    pub target_date: Option<Option<String>>,
    pub account_id: Option<Option<i64>>,
    pub saved_cents: Option<Option<i64>>,
    pub archived: Option<bool>,
}

pub fn update_goal<S: Store>(store: &S, g: &GoalChange, today: &str) -> AppResult<Vec<Goal>> {
    let old = store.goal_get(g.id)?.ok_or_else(|| AppError::new("goals.not_found", "That goal no longer exists."))?;
    check(store, g.account_id.flatten())?;
    let account_id = g.account_id.unwrap_or(old.account_id);
    let saved_cents = match (account_id, g.saved_cents) {
        (Some(_), _) => None,
        (None, Some(saved)) => saved,
        (None, None) => Some(old.saved_cents.unwrap_or(0)),
    };
    store.goal_update(
        g.id,
        &GoalWrite {
            name: g.name.clone().unwrap_or(old.name),
            target_cents: g.target_cents.unwrap_or(old.target_cents),
            target_date: g.target_date.clone().unwrap_or(old.target_date),
            account_id,
            saved_cents,
            archived: g.archived.unwrap_or(old.archived),
        },
    )?;
    list_goals(store, today)
}

pub fn delete_goal<S: Store>(store: &S, id: i64, today: &str) -> AppResult<Vec<Goal>> {
    store.goal_delete(id)?;
    list_goals(store, today)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_whole_months_with_a_minimum_of_one() {
        assert_eq!(months_until("2026-11-14", "2027-11-14"), 12);
        assert_eq!(months_until("2026-11-14", "2027-11-13"), 11);
        assert_eq!(months_until("2026-11-14", "2026-11-20"), 1);
        assert_eq!(months_until("2026-11-14", "2026-12-01"), 1);
    }
}
