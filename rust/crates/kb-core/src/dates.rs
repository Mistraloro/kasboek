//! Calendar helpers with the behaviour of the JavaScript `Date` calls of the TypeScript core (UTC): `Date.parse` of a
//! `YYYY-MM-DD` text (a day up to 31 rolls over into the next month), `Math.round`, `addMonths`, last day of a month.
use crate::clock::civil_from_days;

const DAY_MS: i64 = 86_400_000;

/// `Math.round`: ties go towards positive infinity (Rust's `round` goes away from zero).
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant); `d` may exceed the month's length.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// `Date.parse('YYYY-MM-DD')` in milliseconds, `None` where JavaScript gives NaN (month 1 to 12, day 1 to 31; `2026-02-30` is
/// March 2). Other shapes of text are not read.
pub fn parse_date_ms(date: &str) -> Option<i64> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { b[from..to].iter().all(u8::is_ascii_digit).then(|| date[from..to].parse().ok())? };
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| days_from_civil(y, m, d) * DAY_MS)
}

/// `(Date.parse(b) - Date.parse(a)) / 86_400_000`, NaN when one of them does not read.
pub fn day_diff(a: &str, b: &str) -> f64 {
    match (parse_date_ms(a), parse_date_ms(b)) {
        (Some(a), Some(b)) => (b - a) as f64 / DAY_MS as f64,
        _ => f64::NAN,
    }
}

fn iso_date(days: i64) -> Option<String> {
    let (y, m, d) = civil_from_days(days);
    (0..=9999).contains(&y).then(|| format!("{y:04}-{m:02}-{d:02}"))
}

/// `addDays`: the date `Math.round(days)` days later. `None` where JavaScript's `toISOString` would throw.
pub fn add_days(date: &str, days: f64) -> Option<String> {
    let ms = parse_date_ms(date)?;
    iso_date(ms.div_euclid(DAY_MS) + js_round(days) as i64)
}

fn split_month(month: &str) -> (i64, i64) {
    (month.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0), month.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1))
}

/// `addMonths(month, n)` of src/shared/month.ts for a `YYYY-MM`. Like `new Date(y, m - 1 + n, 1)`, a year from 0 to 99
/// means 1900 to 1999, and the year is printed without leading zeros (`getFullYear()`).
pub fn add_months(month: &str, n: i64) -> String {
    let (y, m) = split_month(month);
    let y = if (0..100).contains(&y) { y + 1900 } else { y };
    let total = y * 12 + (m - 1) + n;
    format!("{}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
}

/// The number of days of a month of a `YYYY-MM` (`new Date(Date.UTC(y, m, 0)).getUTCDate()`).
pub fn days_in_month(month: &str) -> i64 {
    let (y, m) = split_month(month);
    days_from_civil(y + m / 12, m % 12 + 1, 1) - days_from_civil(y, m, 1)
}

/// The same day of the month, `n` months later (the 31st becomes the month's last day).
pub fn add_months_to_date(date: &str, n: i64) -> String {
    let month = add_months(&date[..7], n);
    let day: i64 = date.get(8..).and_then(|d| d.parse().ok()).unwrap_or(0);
    format!("{month}-{:02}", day.min(days_in_month(&month)))
}

/// The last day of the month of `date` (`endOfMonth` of alerts.ts).
pub fn end_of_month(date: &str) -> String {
    format!("{}-{:02}", &date[..7], days_in_month(&date[..7]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_javascript() {
        assert_eq!((js_round(-2.5), js_round(2.5), js_round(-0.4), js_round(0.49999999999999994)), (-2.0, 3.0, 0.0, 0.0));
    }

    #[test]
    fn parses_like_date_parse() {
        assert_eq!(parse_date_ms("2026-02-30"), parse_date_ms("2026-03-02"));
        assert_eq!(parse_date_ms("1970-01-02"), Some(86_400_000));
        for bad in ["2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32", "2026-1-01", "x"] {
            assert_eq!(parse_date_ms(bad), None, "{bad}");
        }
        assert_eq!(day_diff("2026-02-28", "2026-03-03"), 3.0);
        assert!(day_diff("2026-02-28", "bad").is_nan());
    }

    #[test]
    fn month_arithmetic() {
        assert_eq!(add_months("2026-01", -1), "2025-12");
        assert_eq!(add_months("2026-11", 14), "2028-01");
        assert_eq!(add_months("0001-01", -5), "1900-08");
        assert_eq!(add_months("0500-12", 1), "501-01");
        assert_eq!(days_in_month("2024-02"), 29);
        assert_eq!(days_in_month("2026-12"), 31);
        assert_eq!(add_months_to_date("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_months_to_date("2024-01-31", 1), "2024-02-29");
        assert_eq!(add_days("2024-02-28", 1.0).as_deref(), Some("2024-02-29"));
        assert_eq!(add_days("2026-12-31", 30.4).as_deref(), Some("2027-01-30"));
        assert_eq!(end_of_month("2026-11-14"), "2026-11-30");
    }
}
