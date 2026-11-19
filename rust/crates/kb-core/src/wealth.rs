//! Net worth and the year view (src/core/wealth.ts). An account's value on a day is its opening balance plus its
//! transactions up to that day; with recorded values the latest one counts instead, plus the transactions after it.
use crate::dates::{add_months, end_of_month};
use crate::error::{AppError, AppResult};
use crate::finance::main_currency;
use kb_db::rows::{AccountRow, CheckpointRow};
use kb_db::Store;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastValuation {
    pub date: String,
    pub value_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthAccount {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub currency: String,
    pub archived: bool,
    pub value_cents: f64,
    pub value_main_cents: Option<f64>,
    pub invested_cents: Option<f64>,
    pub gain_cents: Option<f64>,
    pub last_valuation: Option<LastValuation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetWorthMonth {
    pub month: String,
    pub cents: f64,
    pub unconverted: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorth {
    pub main: String,
    pub total_cents: f64,
    pub assets_cents: f64,
    pub liabilities_cents: f64,
    pub unconverted: i64,
    pub accounts: Vec<NetWorthAccount>,
    pub history: Vec<NetWorthMonth>,
    pub first_month: Option<String>,
}

struct History {
    /// Transaction dates and running totals (account currency), sorted.
    dates: Vec<String>,
    running: Vec<f64>,
    valuations: Vec<CheckpointRow>,
}

fn history<S: Store>(store: &S, a: &AccountRow) -> AppResult<History> {
    let mut dates = Vec::new();
    let mut running = Vec::new();
    let mut total = 0.0;
    for (date, sum) in store.tx_daily_sums(a.id, &a.currency)? {
        total += sum;
        dates.push(date);
        running.push(total);
    }
    Ok(History { dates, running, valuations: store.checkpoints(a.id)? })
}

/// Sum of transactions on or before `date`.
fn tx_up_to(h: &History, date: &str) -> f64 {
    match h.dates.partition_point(|d| d.as_str() <= date) {
        0 => 0.0,
        n => h.running[n - 1],
    }
}

struct Value<'a> {
    value: f64,
    invested: f64,
    valuation: Option<&'a CheckpointRow>,
}

fn value_on<'a>(a: &AccountRow, h: &'a History, date: &str) -> Value<'a> {
    let invested = a.opening_balance_cents as f64 + tx_up_to(h, date);
    let valuation = h.valuations.iter().rfind(|v| v.date.as_str() <= date);
    match valuation {
        None => {
            // A bank account before its first recorded balance: work back from that balance, so the starting balance
            // doesn't have to be known. (An investment counts what was paid in.)
            if let Some(next) = h.valuations.first().filter(|_| a.kind != "investment") {
                return Value { value: next.value as f64 - (tx_up_to(h, &next.date) - tx_up_to(h, date)), invested, valuation: None };
            }
            Value { value: invested, invested, valuation: None }
        }
        Some(v) => Value { value: v.value as f64 + tx_up_to(h, date) - tx_up_to(h, &v.date), invested, valuation },
    }
}

pub fn net_worth<S: Store>(store: &S, months: i64, today: &str) -> AppResult<NetWorth> {
    let main = main_currency(store)?;
    let accounts = store.accounts_all()?;
    let mut histories = HashMap::new();
    for a in &accounts {
        histories.insert(a.id, history(store, a)?);
    }
    let (mut assets, mut liabilities, mut unconverted) = (0.0, 0.0, 0);
    let mut rows = Vec::with_capacity(accounts.len());
    for a in &accounts {
        let h = &histories[&a.id];
        let v = value_on(a, h, today);
        let value_main = store.fx_convert(v.value, &a.currency, today, &main)?;
        match value_main {
            None => unconverted += 1,
            Some(m) if a.kind == "credit_card" || a.kind == "loan" || m < 0.0 => liabilities += m,
            Some(m) => assets += m,
        }
        let tracked = !h.valuations.is_empty();
        rows.push(NetWorthAccount {
            id: a.id,
            name: a.name.clone(),
            kind: a.kind.clone(),
            currency: a.currency.clone(),
            archived: a.archived,
            value_cents: v.value,
            value_main_cents: value_main,
            invested_cents: tracked.then_some(v.invested),
            gain_cents: tracked.then_some(v.value - v.invested),
            last_valuation: v.valuation.map(|l| LastValuation { date: l.date.clone(), value_cents: l.value }),
        });
    }

    // Month-end values, from the first month with any data (or `months` back) to this month.
    let this_month = &today[..7];
    let first = store.first_data_date()?;
    let first_month = first.as_deref().map(|f| f.get(..7).unwrap_or(f).to_owned());
    let mut start =
        if months > 0 { add_months(this_month, -(months - 1)) } else { first_month.clone().unwrap_or_else(|| this_month.to_owned()) };
    if let Some(f) = &first_month {
        if start < *f {
            start = f.clone();
        }
    }
    let mut history_rows = Vec::new();
    let mut m = start;
    while m.as_str() <= this_month {
        let day = if m == this_month { today.to_owned() } else { end_of_month(&format!("{m}-01")) };
        let (mut total, mut missing) = (0.0, 0);
        for a in &accounts {
            let v = value_on(a, &histories[&a.id], &day).value;
            if v == 0.0 {
                continue;
            }
            match store.fx_convert(v, &a.currency, &day, &main)? {
                None => missing += 1,
                Some(c) => total += c,
            }
        }
        history_rows.push(NetWorthMonth { month: m.clone(), cents: total, unconverted: missing });
        m = add_months(&m, 1);
    }
    Ok(NetWorth {
        main,
        total_cents: assets + liabilities,
        assets_cents: assets,
        liabilities_cents: liabilities,
        unconverted,
        accounts: rows,
        history: history_rows,
        first_month,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearMonth {
    pub month: String,
    pub income_cents: f64,
    pub spending_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearCategory {
    pub category_id: Option<i64>,
    pub name: String,
    pub kind: &'static str,
    pub months: Vec<f64>,
    pub total_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearTotal {
    pub year: i64,
    pub income_cents: f64,
    pub spending_cents: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearSummary {
    pub year: i64,
    pub months: Vec<YearMonth>,
    pub categories: Vec<YearCategory>,
    pub income_cents: f64,
    pub spending_cents: f64,
    pub budgeted_cents: i64,
    pub years: Vec<YearTotal>,
}

/// Income and spending per month and per category for one year, plus totals for every year.
pub fn year_summary<S: Store>(store: &S, year: i64) -> AppResult<YearSummary> {
    let main = main_currency(store)?;
    let rows = store.year_rows(&main, &format!("{year}-01-01"), &format!("{}-01-01", year + 1))?;
    let mut months: Vec<YearMonth> =
        (1..=12).map(|i| YearMonth { month: format!("{year}-{i:02}"), income_cents: 0.0, spending_cents: 0.0 }).collect();
    let mut cats: Vec<(String, YearCategory)> = Vec::new();
    for r in &rows {
        if r.kind == "transfer" {
            continue;
        }
        let i = match r.month.parse::<usize>() {
            Ok(m @ 1..=12) => m - 1,
            _ => return Err(AppError::failed()),
        };
        // Refunds lower spending, reversals lower income (as in the month summary).
        match (r.category_id, r.kind.as_str()) {
            (None, _) => {
                months[i].income_cents += r.income;
                months[i].spending_cents += r.outgoing;
            }
            (Some(_), "income") => months[i].income_cents += r.income - r.outgoing,
            _ => months[i].spending_cents += r.outgoing - r.income,
        }
        // Spending categories count money out minus refunds; income categories money in minus reversals. Uncategorised
        // money in is listed under income, money out under spending.
        let parts: Vec<(&'static str, f64)> = match (r.category_id, r.kind.as_str()) {
            (None, _) => vec![("income", r.income), ("expense", r.outgoing)],
            (Some(_), "income") => vec![("income", r.income - r.outgoing)],
            _ => vec![("expense", r.outgoing - r.income)],
        };
        for (kind, amount) in parts {
            if amount == 0.0 {
                continue;
            }
            let key = format!("{kind}:{}", r.category_id.map_or_else(|| "none".to_owned(), |c| c.to_string()));
            let at = match cats.iter().position(|(k, _)| *k == key) {
                Some(at) => at,
                None => {
                    cats.push((
                        key,
                        YearCategory {
                            category_id: r.category_id,
                            name: r.name.clone().unwrap_or_default(),
                            kind,
                            months: vec![0.0; 12],
                            total_cents: 0.0,
                        },
                    ));
                    cats.len() - 1
                }
            };
            cats[at].1.months[i] += amount;
            cats[at].1.total_cents += amount;
        }
    }
    let mut categories: Vec<YearCategory> = cats.into_iter().map(|(_, c)| c).filter(|c| c.total_cents != 0.0).collect();
    categories.sort_by(|a, b| {
        if a.kind == b.kind {
            b.total_cents.total_cmp(&a.total_cents)
        } else if a.kind == "income" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    let years = store
        .year_totals(&main)?
        .into_iter()
        .map(|r| YearTotal { year: r.year, income_cents: r.income, spending_cents: r.spending })
        .collect();
    let income = months.iter().map(|m| m.income_cents).sum();
    let spending = months.iter().map(|m| m.spending_cents).sum();
    let budgeted_cents = store.budgets_sum(&format!("{year}-01"), &format!("{year}-12"))?;
    Ok(YearSummary { year, months, categories, income_cents: income, spending_cents: spending, budgeted_cents, years })
}
