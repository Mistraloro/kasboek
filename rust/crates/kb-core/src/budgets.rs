//! Budgets and the monthly summary (src/core/finance.ts).
use crate::dates::add_months;
use crate::error::{AppError, AppResult};
use crate::finance::{main_currency, month_range};
use kb_db::Store;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRow {
    pub category_id: i64,
    pub name: String,
    pub budget_cents: Option<i64>,
    pub spent_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpending {
    pub category_id: Option<i64>,
    pub name: String,
    pub cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotals {
    pub month: String,
    pub income_cents: f64,
    pub spending_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSummary {
    pub month: String,
    pub income_cents: f64,
    pub spending_cents: f64,
    pub budgeted_cents: i64,
    pub left_cents: Option<f64>,
    pub by_category: Vec<CategorySpending>,
    pub uncategorized: i64,
    pub unconverted: i64,
    pub history: Vec<MonthTotals>,
}

/// Spending per category for a month: money out minus refunds, transfers excluded.
pub fn spent_by_category<S: Store>(store: &S, month: &str) -> AppResult<Vec<(Option<i64>, f64)>> {
    let (from, to) = month_range(month);
    Ok(store.spent_by_category(&main_currency(store)?, &from, &to)?)
}

pub fn list_budgets<S: Store>(store: &S, month: &str) -> AppResult<Vec<BudgetRow>> {
    let spent = spent_by_category(store, month)?;
    Ok(store
        .budget_categories(month)?
        .into_iter()
        .map(|r| BudgetRow {
            category_id: r.id,
            name: r.name,
            budget_cents: r.amount_cents,
            spent_cents: spent.iter().find(|(id, _)| *id == Some(r.id)).map_or(0.0, |(_, cents)| *cents),
        })
        .collect())
}

pub fn set_budget<S: Store>(store: &S, category_id: i64, month: &str, amount_cents: Option<i64>) -> AppResult<Vec<BudgetRow>> {
    if store.category_kind(category_id)?.as_deref() != Some("expense") {
        return Err(AppError::new("budgets.not_expense", "Budgets can only be set for spending categories."));
    }
    match amount_cents {
        None => store.budget_delete(category_id, month)?,
        Some(cents) => store.budget_upsert(category_id, month, cents)?,
    }
    list_budgets(store, month)
}

pub fn copy_budgets<S: Store>(store: &S, month: &str) -> AppResult<u64> {
    Ok(store.budgets_copy(month, &add_months(month, -1))?)
}

fn income_and_spending<S: Store>(store: &S, month: &str) -> AppResult<(f64, f64)> {
    let (from, to) = month_range(month);
    Ok(store.income_and_spending(&main_currency(store)?, &from, &to)?)
}

pub fn month_summary<S: Store>(store: &S, month: &str) -> AppResult<MonthSummary> {
    let (income, spending) = income_and_spending(store, month)?;
    let budgets = list_budgets(store, month)?;
    let budgeted: Vec<&BudgetRow> = budgets.iter().filter(|b| b.budget_cents.is_some()).collect();
    let budgeted_cents: i64 = budgeted.iter().map(|b| b.budget_cents.unwrap_or(0)).sum();
    let spent_on_budgeted: f64 = budgeted.iter().map(|b| b.spent_cents).sum();
    let names = store.categories_all()?;
    let mut by_category: Vec<CategorySpending> = spent_by_category(store, month)?
        .into_iter()
        .filter(|(_, cents)| *cents > 0.0)
        .map(|(id, cents)| CategorySpending {
            category_id: id,
            name: id.and_then(|id| names.iter().find(|c| c.id == id)).map_or_else(String::new, |c| c.name.clone()),
            cents,
        })
        .collect();
    by_category.sort_by(|a, b| b.cents.total_cmp(&a.cents));
    let (from, to) = month_range(month);
    let uncategorized = store.uncategorized_count(&from, &to)?;
    let unconverted = store.unconverted_count(&main_currency(store)?, &from, &to)?;
    let mut history = Vec::with_capacity(6);
    for i in 0..6 {
        let m = add_months(month, i - 5);
        let (income_cents, spending_cents) = income_and_spending(store, &m)?;
        history.push(MonthTotals { month: m, income_cents, spending_cents });
    }
    Ok(MonthSummary {
        month: month.to_owned(),
        income_cents: income,
        spending_cents: spending,
        budgeted_cents,
        left_cents: (!budgeted.is_empty()).then_some(budgeted_cents as f64 - spent_on_budgeted),
        by_category,
        uncategorized,
        unconverted,
        history,
    })
}
