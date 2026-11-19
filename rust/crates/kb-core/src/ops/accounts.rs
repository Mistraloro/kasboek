//! `accounts.list`, `accounts.create`, `accounts.update`.
use super::{json, run};
use crate::balance::{current_balance, list_bank_balances, set_bank_balance, set_valuation};
use crate::core::{Core, Done};
use crate::error::{AppError, AppResult};
use crate::input::{is_none, nullable_optional, optional, Currency, Date, Empty, Id, Int, Percent, Trimmed};
use crate::jsstr::is_js_space;
use kb_db::rows::{AccountRow, NewAccount};
use kb_db::{DbError, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: i64,
    name: String,
    bank: String,
    iban: Option<String>,
    currency: String,
    kind: String,
    opening_balance_cents: i64,
    archived: bool,
    created_at: String,
    fx_cost_pct: Option<f64>,
}

impl From<AccountRow> for Account {
    fn from(r: AccountRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            bank: r.bank,
            iban: r.iban,
            currency: r.currency,
            kind: r.kind,
            opening_balance_cents: r.opening_balance_cents,
            archived: r.archived,
            created_at: r.created_at,
            fx_cost_pct: r.fx_cost_pct,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LastBankBalance {
    date: String,
    balance_cents: i64,
    difference_cents: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountWithBalance {
    #[serde(flatten)]
    account: Account,
    balance_cents: f64,
    balance_main_cents: Option<f64>,
    transaction_count: i64,
    last_bank_balance: Option<LastBankBalance>,
}

/// Removes spaces and upper-cases an IBAN, e.g. `be68 5390 0754 7034` becomes `BE68539007547034`; empty is none.
pub fn normalize_iban(iban: Option<&str>) -> Option<String> {
    let v: String = iban?.chars().filter(|c| !is_js_space(*c)).collect::<String>().to_uppercase();
    (!v.is_empty()).then_some(v)
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| {
        let db = core.db()?;
        let today = core.today();
        let main = crate::settings::get_settings(db)?.get("currency").and_then(Value::as_str).unwrap_or("EUR").to_owned();
        // Balance per account in the account's own currency, and in the main currency at today's rate. With a recorded
        // bank balance (or value), that is the starting point.
        let mut balances = std::collections::HashMap::new();
        for r in db.account_balance_rows()? {
            let balance = if r.checked { current_balance(db, r.id)? } else { r.bal };
            let main_cents = db.fx_convert(balance, &r.currency, &today, &main)?;
            balances.insert(r.id, (balance, main_cents, r.count));
        }
        // The latest recorded bank balance, and whether it matches what Kasboek counted.
        let mut last = std::collections::HashMap::new();
        for id in db.accounts_with_valuations()? {
            if let Some(b) = list_bank_balances(db, id)?.into_iter().next() {
                last.insert(id, LastBankBalance { date: b.date, balance_cents: b.balance_cents, difference_cents: b.difference_cents });
            }
        }
        let out: Vec<AccountWithBalance> = db
            .accounts_all()?
            .into_iter()
            .map(|r| {
                let (balance, main_cents, count) = balances.get(&r.id).copied().unwrap_or((r.opening_balance_cents as f64, None, 0));
                let id = r.id;
                AccountWithBalance {
                    account: r.into(),
                    balance_cents: balance,
                    balance_main_cents: main_cents,
                    transaction_count: count,
                    last_bank_balance: last.remove(&id),
                }
            })
            .collect();
        json(&out)
    })
}

#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    #[default]
    Current,
    Savings,
    Investment,
    Cash,
    CreditCard,
    Loan,
    Other,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Savings => "savings",
            Self::Investment => "investment",
            Self::Cash => "cash",
            Self::CreditCard => "credit_card",
            Self::Loan => "loan",
            Self::Other => "other",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BankBalanceIn {
    date: Date,
    cents: Int,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateIn {
    name: Trimmed<1, 80>,
    #[serde(default)]
    bank: Trimmed<0, 60>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    iban: Option<Option<Trimmed<0, 34>>>,
    #[serde(default)]
    currency: Currency,
    #[serde(default)]
    kind: Kind,
    #[serde(default)]
    opening_balance_cents: Int,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    fx_cost_pct: Option<Option<Percent>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    bank_balance: Option<BankBalanceIn>,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: CreateIn| {
        let db = core.db()?;
        let new = NewAccount {
            name: input.name.0.clone(),
            bank: input.bank.0.clone(),
            iban: normalize_iban(input.iban.as_ref().and_then(|i| i.as_ref()).map(|i| i.0.as_str())),
            currency: input.currency.0.clone(),
            kind: input.kind.as_str().to_owned(),
            opening_balance_cents: input.opening_balance_cents.0,
            fx_cost_pct: input.fx_cost_pct.flatten().map(|p| p.0),
        };
        // Account and its first bank balance together: a refused balance leaves no account behind.
        let row = db.transaction::<_, AppError, _>(|s| {
            let row = s.account_insert(&new).map_err(|e| match e {
                DbError::Unique(_) => AppError::new("accounts.duplicate_iban", "An account with this IBAN already exists."),
                other => other.into(),
            })?;
            // The balance the bank shows now: the starting point for the balance from here on.
            if let Some(b) = &input.bank_balance {
                if input.kind == Kind::Investment {
                    set_valuation(s, row.id, &b.date.0, b.cents.0, None)?;
                } else {
                    set_bank_balance(s, row.id, &b.date.0, b.cents.0, None, &core.today())?;
                }
            }
            Ok(row)
        })?;
        json(&Account::from(row))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    id: Id,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    name: Option<Trimmed<1, 80>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    bank: Option<Trimmed<0, 60>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    iban: Option<Option<Trimmed<0, 34>>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    currency: Option<Currency>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    kind: Option<Kind>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    archived: Option<bool>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    fx_cost_pct: Option<Option<Percent>>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: UpdateIn| {
        let db = core.db()?;
        let cur = db.account_get(input.id.0)?.ok_or_else(|| AppError::new("accounts.not_found", "Account not found."))?;
        let next = AccountRow {
            id: cur.id,
            name: input.name.as_ref().map_or_else(|| cur.name.clone(), |n| n.0.clone()),
            bank: input.bank.as_ref().map_or_else(|| cur.bank.clone(), |b| b.0.clone()),
            iban: match &input.iban {
                Some(iban) => normalize_iban(iban.as_ref().map(|i| i.0.as_str())),
                None => cur.iban.clone(),
            },
            currency: input.currency.as_ref().map_or_else(|| cur.currency.clone(), |c| c.0.clone()),
            kind: input.kind.map_or_else(|| cur.kind.clone(), |k| k.as_str().to_owned()),
            opening_balance_cents: cur.opening_balance_cents,
            archived: input.archived.unwrap_or(cur.archived),
            created_at: cur.created_at.clone(),
            fx_cost_pct: match input.fx_cost_pct {
                Some(p) => p.map(|p| p.0),
                None => cur.fx_cost_pct,
            },
        };
        db.transaction::<_, AppError, _>(|s| {
            s.account_update(&next)?;
            // Changing the currency corrects it: amounts that were in the old one now count in the new one.
            if let Some(currency) = &input.currency {
                if currency.0 != cur.currency {
                    s.account_recurrency_transactions(cur.id, &cur.currency, &currency.0)?;
                }
            }
            Ok(())
        })?;
        let row = db.account_get(input.id.0)?.ok_or_else(AppError::failed)?;
        json(&Account::from(row))
    })
}
