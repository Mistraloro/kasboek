//! The SQL function `fx(cents, from, date, to)`. Port of `convert`, `ratePerEur` and `installFx` in src/core/fx.ts.
//!
//! Rates are stored per euro; any two currencies convert through the euro. The rate of a date is the last known one
//! on or before it, or the first one after it when there is nothing earlier. A currency with no rate at all gives NULL.
//! All rates are loaded up front because SQLite does not allow queries from inside a user-defined function.
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock};

#[derive(Default)]
struct Series {
    dates: Vec<String>,
    rates: Vec<f64>,
}

#[derive(Clone, Default)]
pub(crate) struct FxRates(Arc<RwLock<HashMap<String, Series>>>);

impl FxRates {
    /// Reads the rates table. A manual rate wins over the ECB rate of the same day (it sorts last and replaces it).
    /// An older database opened without migrating has no rates table yet: no rates.
    pub(crate) fn reload(&self, conn: &Connection) -> rusqlite::Result<()> {
        let has_table: bool =
            conn.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fx_rates')", [], |r| r.get(0))?;
        let mut map: HashMap<String, Series> = HashMap::new();
        if has_table {
            let mut stmt = conn.prepare(
                "SELECT currency, date, per_eur FROM fx_rates ORDER BY currency, date, CASE source WHEN 'manual' THEN 1 ELSE 0 END",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?)))?;
            for row in rows {
                let (currency, date, per_eur) = row?;
                let series = map.entry(currency).or_default();
                if series.dates.last() == Some(&date) {
                    *series.rates.last_mut().expect("same length as dates") = per_eur;
                } else {
                    series.dates.push(date);
                    series.rates.push(per_eur);
                }
            }
        }
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = map;
        Ok(())
    }

    /// Units of `currency` for 1 euro on `date`, or `None` when the currency has no rate at all.
    fn rate_per_eur(&self, currency: &str, date: &str) -> Option<f64> {
        if currency == "EUR" {
            return Some(1.0);
        }
        let map = self.0.read().unwrap_or_else(PoisonError::into_inner);
        let series = map.get(currency)?;
        // The last date <= `date`; if none, the first rate. Dates compare as strings, like in the TypeScript core.
        let after = series.dates.partition_point(|d| d.as_str() <= date);
        Some(series.rates[after.saturating_sub(1)])
    }

    pub(crate) fn convert(&self, cents: f64, from: &str, date: &str, to: &str) -> Option<f64> {
        if from == to {
            return Some(cents);
        }
        let (a, b) = (self.rate_per_eur(from, date)?, self.rate_per_eur(to, date)?);
        Some(js_round((cents / a) * b))
    }
}

/// `Math.round`: ties go towards positive infinity (Rust's `round` goes away from zero), and a negative value that
/// rounds to zero gives -0.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `String(value)` for the argument types SQLite can pass, as the TypeScript function does it.
fn js_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "null".into(),
        ValueRef::Integer(i) => js_number(i as f64),
        ValueRef::Real(r) => js_number(r),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn js_number(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

fn fx_function(rates: &FxRates, ctx: &Context<'_>) -> rusqlite::Result<Option<f64>> {
    // Only numbers convert; better-sqlite3 hands integers and reals over as JavaScript numbers.
    let cents = match ctx.get_raw(0) {
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(r) => r,
        _ => return Ok(None),
    };
    Ok(rates.convert(cents, &js_string(ctx.get_raw(1)), &js_string(ctx.get_raw(2)), &js_string(ctx.get_raw(3))))
}

/// Loads the rates and registers `fx`. Like better-sqlite3's `{ deterministic: false }`, the function is not
/// flagged deterministic (its answer changes with the rates table), and it returns a REAL, or NULL.
pub(crate) fn install(conn: &Connection, rates: &FxRates) -> rusqlite::Result<()> {
    rates.reload(conn)?;
    let rates = rates.clone();
    conn.create_scalar_function("fx", 4, FunctionFlags::SQLITE_UTF8, move |ctx| fx_function(&rates, ctx))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rates() -> FxRates {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE fx_rates (currency TEXT, date TEXT, per_eur REAL, source TEXT);
             INSERT INTO fx_rates VALUES ('USD','2025-01-01',1.10,'ecb'),('USD','2025-01-10',1.20,'ecb'),
                                         ('USD','2025-01-10',1.25,'manual'),('JPY','2025-01-05',160.0,'ecb');",
        )
        .unwrap();
        let r = FxRates::default();
        r.reload(&conn).unwrap();
        r
    }

    #[test]
    fn rate_lookup_uses_the_last_rate_on_or_before_and_manual_wins() {
        let r = rates();
        assert_eq!(r.rate_per_eur("USD", "2024-12-31"), Some(1.10), "before the first: the first");
        assert_eq!(r.rate_per_eur("USD", "2025-01-09"), Some(1.10));
        assert_eq!(r.rate_per_eur("USD", "2025-01-10"), Some(1.25), "manual replaces ecb");
        assert_eq!(r.rate_per_eur("USD", "2030-01-01"), Some(1.25));
        assert_eq!(r.rate_per_eur("EUR", "x"), Some(1.0));
        assert_eq!(r.rate_per_eur("CHF", "2025-01-01"), None);
    }

    #[test]
    fn convert_goes_through_the_euro_and_rounds_like_math_round() {
        let r = rates();
        assert_eq!(r.convert(1000.0, "EUR", "2025-01-02", "USD"), Some(1100.0));
        assert_eq!(r.convert(1100.0, "USD", "2025-01-02", "EUR"), Some(1000.0));
        assert_eq!(r.convert(5.0, "USD", "2025-01-02", "USD"), Some(5.0));
        assert_eq!(r.convert(5.0, "CHF", "2025-01-02", "EUR"), None);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert!(js_round(-0.3).is_sign_negative() && js_round(-0.3) == 0.0);
    }
}
