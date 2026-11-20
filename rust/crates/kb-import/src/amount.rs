//! Money amounts as people and banks write them: `parseAmount` of src/shared/amount.ts.
use crate::jsstr::{js_trim, JS_SPACE};
use regex::Regex;
use std::sync::LazyLock;

/// Which character is the decimal mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decimal {
    Comma,
    Dot,
    /// Guess from the last separator.
    Auto,
}

/// `\s*\b(DR|CR)\.?$` without regard to case: UK statements mark money out as "12.50 DR".
static SIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[{JS_SPACE}]*(?-u:\b)([dD][rR]|[cC][rR])\.?$")).expect("side regex"));
/// Currency signs and codes before or after the number.
static CURRENCY_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[A-Za-z]{{1,3}}\$|^[A-Z]{{3}}[{s}]*|[{s}]*[A-Z]{{3}}$|[{s}]*(?:kr|zł|zl|Fr|fr|Kč)\.?$|^(?:kr|Fr)\.?[{s}]*",
        s = JS_SPACE
    ))
    .expect("currency regex")
});
static SYMBOLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[€$£¥₹₩₺₽₴₫฿₪{JS_SPACE}\u00A0\u202F]")).expect("symbols regex"));

/// Parses a money amount: "12,50", "-1.234,56", "1 234,56", "+12.00", "12,50-", "€ 3,20", "(4,00)", "USD 12.50", "12.50 DR".
/// Returns cents or `None`. `decimal` forces the decimal separator; `Auto` guesses from the last separator, and `prefer`
/// decides when a lone separator with three digits after it is ambiguous.
pub fn parse_amount(input: &str, decimal: Decimal, prefer: char) -> Option<i64> {
    let mut s = js_trim(input).to_owned();
    // "12.50 DR" / "12.50 CR": debit is money out.
    let mut negative = false;
    if let Some(m) = SIDE.captures(&s) {
        negative = m[1].eq_ignore_ascii_case("DR");
        let start = m.get(0)?.start();
        s.truncate(start);
    }
    let s = CURRENCY_TEXT.replace_all(&s, "");
    let mut s = SYMBOLS.replace_all(&s, "").into_owned();
    if s.is_empty() {
        return None;
    }
    if s.len() >= 2 && s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = s[1..s.len() - 1].to_owned();
    }
    if s.ends_with('-') {
        negative = !negative;
        s.pop();
    }
    if s.starts_with('-') {
        negative = !negative;
        s.remove(0);
    } else if s.starts_with('+') {
        s.remove(0);
    }
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b',' | b'\'')) {
        return None;
    }

    let dec = match decimal {
        Decimal::Comma => ',',
        Decimal::Dot => '.',
        Decimal::Auto => {
            let last_comma = s.rfind(',');
            let last_dot = s.rfind('.');
            match (last_comma, last_dot) {
                (Some(c), Some(d)) => {
                    if c > d {
                        ','
                    } else {
                        '.'
                    }
                }
                (Some(c), None) => {
                    if s.len() - c - 1 == 3 && (s.split(',').count() > 2 || prefer == '.') {
                        '.'
                    } else {
                        ','
                    }
                }
                (None, Some(d)) => {
                    if s.len() - d - 1 == 3 && (s.split('.').count() > 2 || prefer == ',') {
                        ','
                    } else {
                        '.'
                    }
                }
                (None, None) => prefer,
            }
        }
    };
    let kept: String = s.chars().filter(|&c| if dec == ',' { c != '.' && c != '\'' } else { c != ',' && c != '\'' }).collect();
    // `replace(',', '.')`: the first comma only.
    let normalized = kept.replacen(',', ".", 1);
    let (whole, frac) = match normalized.split_once('.') {
        Some((w, f)) => (w, f),
        None => (normalized.as_str(), ""),
    };
    // `^\d+(\.\d+)?$`: split('.') also leaves a second dot inside `frac`, which the digit check below refuses.
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (normalized.contains('.') && !digits(frac)) {
        return None;
    }
    if frac.len() > 2 && !frac[2..].bytes().all(|b| b == b'0') {
        return None;
    }
    let frac2 = format!("{frac}00");
    let cents = whole.parse::<f64>().ok()? * 100.0 + frac2[..2].parse::<f64>().ok()?;
    if !cents.is_finite() || cents.fract() != 0.0 || cents.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    let cents = cents as i64;
    Some(if negative { -cents } else { cents })
}

/// `parseAmount(text, decimal)` as the import uses it: a forced decimal mark, a comma preferred.
pub fn parse_amount_with(text: &str, decimal: char) -> Option<i64> {
    parse_amount(text, if decimal == '.' { Decimal::Dot } else { Decimal::Comma }, ',')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto(s: &str) -> Option<i64> {
        parse_amount(s, Decimal::Auto, ',')
    }

    #[test]
    fn parses_belgian_and_international_amounts() {
        assert_eq!(auto("-1.234,56"), Some(-123_456));
        assert_eq!(auto("2.850,00"), Some(285_000));
        assert_eq!(auto("+3,12"), Some(312));
        assert_eq!(auto("12,50-"), Some(-1250));
        assert_eq!(parse_amount("1,234.56", Decimal::Dot, ','), Some(123_456));
        assert_eq!(auto("€ 1 234,5"), Some(123_450));
        assert_eq!(auto("(4,00)"), Some(-400));
        assert_eq!(auto("abc"), None);
        assert_eq!(auto("1,234"), None, "ambiguous on its own: refused, not guessed");
        assert_eq!(parse_amount("1,234", Decimal::Dot, ','), Some(123_400));
        assert_eq!(auto("1.234.567"), Some(123_456_700));
    }

    #[test]
    fn reads_codes_and_sides() {
        assert_eq!(auto("USD 12.50"), Some(1250));
        assert_eq!(auto("12.50 DR"), Some(-1250));
        assert_eq!(auto("12.50 cr"), Some(1250));
        assert_eq!(auto("12.50DR"), None, "no word boundary");
        assert_eq!(auto("12,50 CHF"), Some(1250));
        assert_eq!(auto("kr 100"), Some(10_000));
        assert_eq!(auto("R$ 9,90"), Some(990));
        assert_eq!(auto("-(4,00)"), None, "the sign comes first, so the brackets are left in");
        assert_eq!(auto("1,2,3"), None);
        assert_eq!(auto("12,345"), None);
        assert_eq!(auto("0,125"), None);
        assert_eq!(auto("0,120"), Some(12));
        assert_eq!(auto("99999999999999999999"), None);
        assert_eq!(auto(""), None);
        assert_eq!(auto("-"), None);
    }
}
