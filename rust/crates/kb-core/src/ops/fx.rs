//! `fx.status`, `fx.rates`, `fx.setRate`, `fx.deleteRate`: the exchange-rate operations that work on stored rates
//! (src/core/fx.ts). The ECB download is a desktop operation and not ported here.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::{AppError, AppResult};
use crate::input::{is_none, optional, Currency, Date, Empty, PerEur};
use crate::settings::get_settings;
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FxRate {
    currency: String,
    date: String,
    per_eur: f64,
    source: String,
}

fn is_currency_code(c: &str) -> bool {
    c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())
}

/// Currencies in use (accounts, transactions, the main currency, manual rates) other than the euro, with their rates.
fn status_value<S: Store>(store: &S) -> AppResult<Value> {
    let settings = get_settings(store)?;
    let main = settings.get("currency").and_then(Value::as_str).unwrap_or("EUR").to_owned();
    let mut used: Vec<String> = store.fx_used_currencies(&main)?.into_iter().filter(|c| c != "EUR" && is_currency_code(c)).collect();
    used.sort();
    let mut currencies = Vec::with_capacity(used.len());
    for currency in used {
        let facts = store.fx_currency_facts(&currency)?;
        // Transactions older than the first rate use that first rate.
        let covers_oldest = facts.oldest_tx.is_none()
            || facts.first_rate.as_ref().zip(facts.oldest_tx.as_ref()).is_some_and(|(first, oldest)| first <= oldest);
        currencies.push(json!({
            "currency": facts.currency,
            "latest": facts.latest.map(|l| json!({"date": l.date, "perEur": l.per_eur, "source": l.source})),
            "ecbRates": facts.ecb_rates,
            "manualRates": facts.manual_rates,
            "coversOldest": covers_oldest,
        }));
    }
    Ok(json!({
        "main": main,
        "currencies": currencies,
        "lastEcbUpdateAt": settings.get("fxLastEcbUpdateAt").cloned().unwrap_or(Value::Null),
        "autoUpdate": settings.get("fxAutoUpdate").cloned().unwrap_or(Value::Null),
    }))
}

pub fn status<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| status_value(core.db()?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RatesIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    currency: Option<Currency>,
}

pub fn rates<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: RatesIn| {
        let rows = core.db()?.fx_manual_rates(input.currency.as_ref().map(|c| c.0.as_str()))?;
        json(
            &rows
                .into_iter()
                .map(|r| FxRate { currency: r.currency, date: r.date, per_eur: r.per_eur, source: "manual".into() })
                .collect::<Vec<_>>(),
        )
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetRateIn {
    currency: Currency,
    date: Date,
    per_eur: PerEur,
}

pub fn set_rate<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: SetRateIn| {
        let db = core.db()?;
        if input.currency.0 == "EUR" {
            return Err(AppError::new("fx.eur", "The euro is the base of all rates; it is always 1."));
        }
        db.fx_set_manual_rate(&input.currency.0, &input.date.0, input.per_eur.0)?;
        db.reload_fx_rates()?;
        status_value(db)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeleteRateIn {
    currency: Currency,
    date: Date,
}

pub fn delete_rate<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |input: DeleteRateIn| {
        let db = core.db()?;
        db.fx_delete_manual_rate(&input.currency.0, &input.date.0)?;
        db.reload_fx_rates()?;
        status_value(db)
    })
}
