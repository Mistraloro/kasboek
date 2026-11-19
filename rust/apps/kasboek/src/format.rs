//! Numbers, money and months as the person set them up: `formatMoney`, `formatNumber` and the month labels of
//! `src/shared/format.ts` and `src/renderer/src/lib/format.ts` (English month names; other languages need CLDR data).
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Formats {
    pub decimal: String,
    pub group: String,
    pub grouping: String,
    pub currency_position: String,
    pub currency_style: String,
    pub negative: String,
    pub date: String,
}

impl Default for Formats {
    fn default() -> Self {
        Self {
            decimal: ",".into(),
            group: ".".into(),
            grouping: "thousands".into(),
            currency_position: "before".into(),
            currency_style: "symbol".into(),
            negative: "minus".into(),
            date: "DD/MM/YYYY".into(),
        }
    }
}

pub const MONTHS: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

impl Formats {
    pub fn from_json(v: &Value) -> Self {
        let d = Self::default();
        let get = |k: &str, fallback: &str| v[k].as_str().unwrap_or(fallback).to_string();
        Self {
            decimal: get("decimal", &d.decimal),
            group: get("group", &d.group),
            grouping: get("grouping", &d.grouping),
            currency_position: get("currencyPosition", &d.currency_position),
            currency_style: get("currencyStyle", &d.currency_style),
            negative: get("negative", &d.negative),
            date: get("date", &d.date),
        }
    }

    fn group_digits(&self, digits: &str) -> String {
        let sep = if self.group == " " { "\u{202F}" } else { self.group.as_str() };
        if sep.is_empty() || digits.len() <= 3 {
            return digits.to_string();
        }
        let (mut rest, last3) = digits.split_at(digits.len() - 3);
        let size = if self.grouping == "indian" { 2 } else { 3 };
        let mut parts: Vec<&str> = Vec::new();
        while rest.len() > size {
            let (head, tail) = rest.split_at(rest.len() - size);
            parts.insert(0, tail);
            rest = head;
        }
        if !rest.is_empty() {
            parts.insert(0, rest);
        }
        parts.push(last3);
        parts.join(sep)
    }

    /// A plain non-negative amount with the chosen separators: 123450 cents, 2 digits -> "1.234,50".
    fn number(&self, abs_cents: u64, digits: u32) -> String {
        if digits == 0 {
            return self.group_digits(&((abs_cents + 50) / 100).to_string());
        }
        format!("{}{}{:02}", self.group_digits(&(abs_cents / 100).to_string()), self.decimal, abs_cents % 100)
    }

    /// `formatMoney`: money from integer minor units.
    pub fn money(&self, cents: i64, currency: &str) -> String {
        let digits = if matches!(currency, "JPY" | "KRW" | "VND" | "CLP" | "ISK" | "UGX" | "XAF" | "XOF") { 0 } else { 2 };
        let number = self.number(cents.unsigned_abs(), digits);
        let negative = cents < 0 && number.chars().any(|c| ('1'..='9').contains(&c));
        let unit = if self.currency_style == "code" { currency.to_string() } else { symbol(currency) };
        let code_like = unit.chars().count() > 1 && unit.chars().all(|c| c.is_ascii_uppercase());
        let space = if self.currency_position.ends_with("space") || code_like { "\u{A0}" } else { "" };
        let before = self.currency_position.starts_with("before");
        let plain = if before { format!("{unit}{space}{number}") } else { format!("{number}{space}{unit}") };
        if !negative {
            return plain;
        }
        match self.negative.as_str() {
            "parentheses" => format!("({plain})"),
            "minus-after-symbol" if before => format!("{unit}{space}−{number}"),
            _ => format!("−{plain}"),
        }
    }

    /// `formatDate` of an ISO date in the person's pattern.
    pub fn date(&self, iso: &str) -> String {
        kb_ui::rules::format_date(iso, &self.date, &kb_ui::rules::EN)
    }
}

/// `Intl.NumberFormat('en', {style: 'currency'})` symbols of the common currencies; the code for the rest.
fn symbol(currency: &str) -> String {
    match currency {
        "EUR" => "€",
        "USD" => "$",
        "GBP" => "£",
        "JPY" => "¥",
        "CNY" => "CN¥",
        "INR" => "₹",
        "KRW" => "₩",
        "BRL" => "R$",
        "AUD" => "A$",
        "CAD" => "CA$",
        "NZD" => "NZ$",
        "MXN" => "MX$",
        "HKD" => "HK$",
        "ILS" => "₪",
        "VND" => "₫",
        other => other,
    }
    .to_string()
}

/// "November 2026".
pub fn month_label(year: i32, month: u32) -> String {
    format!("{} {year}", MONTHS[(month as usize).clamp(1, 12) - 1])
}

/// "Nov".
pub fn month_short(month: u32) -> String {
    MONTHS[(month as usize).clamp(1, 12) - 1].chars().take(3).collect()
}

/// (year, month, day) of a day count since 1970-01-01 (proleptic Gregorian).
pub fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((yoe + era * 400 + i64::from(m <= 2)) as i32, m, d)
}

/// Today (UTC) as year, month, day.
pub fn today_utc() -> (i32, u32, u32) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    civil_from_days((secs / 86_400) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_like_the_renderer() {
        let f = Formats::default();
        assert_eq!(f.money(269_000, "EUR"), "€2.690,00");
        assert_eq!(f.money(-33_689, "EUR"), "−€336,89");
        assert_eq!(f.money(0, "EUR"), "€0,00");
        assert_eq!(f.money(-1, "EUR"), "−€0,01");
        assert_eq!(f.money(123_456_789, "EUR"), "€1.234.567,89");
        assert_eq!(f.money(150, "JPY"), "¥2");
        assert_eq!(f.money(500, "CHF"), "CHF\u{A0}5,00");
        let indian = Formats { grouping: "indian".into(), group: ",".into(), decimal: ".".into(), ..Formats::default() };
        assert_eq!(indian.money(123_456_789, "INR"), "₹12,34,567.89");
        let paren = Formats { negative: "parentheses".into(), currency_position: "after-space".into(), ..Formats::default() };
        assert_eq!(paren.money(-1250, "EUR"), "(12,50\u{A0}€)");
    }

    #[test]
    fn dates_and_months() {
        assert_eq!(month_label(2026, 11), "November 2026");
        assert_eq!(month_short(3), "Mar");
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_453), (2025, 12, 31));
        assert_eq!(Formats::default().date("2026-11-05"), "05/11/2026");
    }
}
