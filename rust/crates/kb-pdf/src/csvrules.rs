//! The pieces of the CSV import that the statement reader uses (src/core/csv/mapping.ts, src/core/csv/normalize.ts,
//! src/shared/amount.ts), ported one to one so that `kb-pdf` does not depend on `kb-import`. They are private to this
//! crate; the same logic lives in `kb-import` for CSV files, and the differential tests compare both with the TypeScript.
use crate::js::{self, re, rei};
use crate::synonyms::SYNONYMS;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DateOrder {
    Dmy,
    Mdy,
    Ymd,
}

// ------------------------------------------------------------------------------------------ dates

const MONTH_NAMES: [&[&str]; 12] = [
    &["jan", "january", "januari", "janvier", "januar", "jänner", "enero", "ene", "janeiro", "gennaio", "gen", "janv"],
    &["feb", "february", "februari", "fevrier", "februar", "febrero", "fevereiro", "fev", "febbraio", "fevr"],
    &["mar", "march", "maart", "mars", "marz", "maerz", "marzo", "marco", "mrt"],
    &["apr", "april", "avril", "abril", "aprile", "abr", "avr"],
    &["may", "mei", "mai", "mayo", "maio", "maggio", "mag"],
    &["jun", "june", "juni", "juin", "junio", "junho", "giugno", "giu"],
    &["jul", "july", "juli", "juillet", "julio", "julho", "luglio", "lug", "juil"],
    &["aug", "august", "augustus", "aout", "agosto", "ago"],
    &["sep", "sept", "september", "septembre", "septiembre", "setembro", "settembre", "set"],
    &["oct", "october", "oktober", "octobre", "octubre", "outubro", "ottobre", "okt", "out", "ott"],
    &["nov", "november", "novembre", "noviembre", "novembro"],
    &["dec", "december", "decembre", "dezember", "diciembre", "dezembro", "dicembre", "dic", "dez"],
];

static MONTHS: LazyLock<HashMap<&'static str, u32>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for (i, names) in MONTH_NAMES.iter().enumerate() {
        for n in *names {
            m.insert(*n, i as u32 + 1);
        }
    }
    m
});

fn number(s: &str) -> Option<f64> {
    s.bytes().all(|b| b.is_ascii_digit()).then(|| s.parse::<f64>().ok()).flatten()
}

/// "16 Nov 2026", "16-nov-26", "Nov 16, 2026", "16. November 2026": day, month name, year in any of these orders.
fn parse_named_date(text: &str) -> Option<(f64, u32, f64)> {
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| re(r"[\s/-]+"));
    let folded: String = text
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
        .chars()
        .map(|c| if c == '.' || c == ',' { ' ' } else { c })
        .collect();
    let words: Vec<&str> = SPLIT.split(&folded).filter(|w| !w.is_empty()).collect();
    let month = words.iter().find_map(|w| MONTHS.get(w).copied());
    let nums: Vec<f64> = words.iter().filter_map(|w| number(w).filter(|_| w.bytes().all(|b| b.is_ascii_digit()))).collect();
    let month = month?;
    if nums.len() < 2 {
        return None;
    }
    let year = nums.iter().copied().find(|n| *n > 31.0).unwrap_or(nums[1]);
    let day = nums.iter().copied().find(|n| *n != year && *n <= 31.0)?;
    Some((year, month, day))
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// `parseDate(text, order)`: an ISO date, or null when the text is no real date in 1990 to 2100.
pub fn parse_date(text: &str, order: DateOrder) -> Option<String> {
    static LETTERS3: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}{3}").unwrap());
    static ISO_T: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{4}-\d{2}-\d{2}T"));
    static SEP: LazyLock<Regex> = LazyLock::new(|| re(r"[-/.]"));
    let s = js::trim(text).split([' ', 'T']).next().unwrap_or("");
    let (mut y, m, d): (f64, f64, f64);
    if LETTERS3.is_match(text) && !ISO_T.is_match(js::trim(text)) {
        let (a, b, c) = parse_named_date(text)?;
        (y, m, d) = (a, f64::from(b), c);
    } else if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        (y, m, d) = (number(&s[0..4])?, number(&s[4..6])?, number(&s[6..])?);
    } else {
        let parts: Vec<f64> = SEP.split(s).map(|p| if p.is_empty() { Some(0.0) } else { number(p) }).collect::<Option<_>>()?;
        if parts.len() != 3 {
            return None;
        }
        (y, m, d) = match order {
            DateOrder::Ymd => (parts[0], parts[1], parts[2]),
            DateOrder::Mdy => (parts[2], parts[0], parts[1]),
            DateOrder::Dmy => (parts[2], parts[1], parts[0]),
        };
    }
    if y < 100.0 {
        y += 2000.0;
    }
    if !(1990.0..=2100.0).contains(&y) || !(1.0..=12.0).contains(&m) || d < 1.0 {
        return None;
    }
    let (yi, mi, di) = (y as i64, m as i64, d as i64);
    if di > days_in_month(yi, mi) {
        return None;
    }
    Some(format!("{yi}-{mi:02}-{di:02}"))
}

// ---------------------------------------------------------------------------------------- amounts

/// `parseAmount(input, decimal, ',')`: cents, or null.
pub fn parse_amount(input: &str, decimal: Option<char>) -> Option<i64> {
    static SIDE: LazyLock<Regex> = LazyLock::new(|| rei(r"\s*\b(DR|CR)\.?$"));
    static CURRENCY: LazyLock<Regex> =
        LazyLock::new(|| re(r"^[A-Za-z]{1,3}\$|^[A-Z]{3}\s*|\s*[A-Z]{3}$|\s*(kr|zł|zl|Fr|fr|Kč)\.?$|^(kr|Fr)\.?\s*"));
    static SIGNS: LazyLock<Regex> = LazyLock::new(|| re(r"[€$£¥₹₩₺₽₴₫฿₪\s\u{a0}\u{202f}]"));
    static CHARS: LazyLock<Regex> = LazyLock::new(|| re(r"^[\d.,']+$"));
    static PLAIN: LazyLock<Regex> = LazyLock::new(|| re(r"^\d+(\.\d+)?$"));
    let mut s = js::trim(input).to_string();
    let mut negative = false;
    if let Some(m) = SIDE.captures(&s) {
        negative = m[1].eq_ignore_ascii_case("DR");
        let at = m.get(0).unwrap().start();
        s.truncate(at);
    }
    let mut s = SIGNS.replace_all(&CURRENCY.replace_all(&s, ""), "").to_string();
    if s.is_empty() {
        return None;
    }
    if s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = s[1..s.len() - 1].to_string();
    }
    if s.ends_with('-') {
        negative = !negative;
        s.pop();
    }
    if let Some(r) = s.strip_prefix('-') {
        negative = !negative;
        s = r.to_string();
    } else if let Some(r) = s.strip_prefix('+') {
        s = r.to_string();
    }
    if !CHARS.is_match(&s) {
        return None;
    }
    let dec = match decimal {
        Some(d) => d,
        None => {
            let (last_comma, last_dot) = (s.rfind(','), s.rfind('.'));
            match (last_comma, last_dot) {
                (Some(c), Some(d)) => {
                    if c > d {
                        ','
                    } else {
                        '.'
                    }
                }
                (Some(c), None) => {
                    if s.len() - c - 1 == 3 && s.split(',').count() > 2 {
                        '.'
                    } else {
                        ','
                    }
                }
                (None, Some(d)) => {
                    if s.len() - d - 1 == 3 {
                        // `prefer` is ',': a lone dot before three digits is a thousands mark
                        ','
                    } else {
                        '.'
                    }
                }
                (None, None) => ',',
            }
        }
    };
    let without: String = s.chars().filter(|c| if dec == ',' { *c != '.' && *c != '\'' } else { *c != ',' && *c != '\'' }).collect();
    let normalized = without.replacen(',', ".", 1);
    if !PLAIN.is_match(&normalized) {
        return None;
    }
    let (whole, frac) = normalized.split_once('.').unwrap_or((&normalized, ""));
    if frac.len() > 2 && !frac[2..].bytes().all(|b| b == b'0') {
        return None;
    }
    let cents = whole.parse::<f64>().ok()? * 100.0 + f64::from(format!("{frac}00")[..2].parse::<u8>().ok()?);
    if cents > 9_007_199_254_740_991.0 {
        return None;
    }
    let cents = cents as i64;
    Some(if negative { -cents } else { cents })
}

/// `detectDecimal(samples)`
pub fn detect_decimal(samples: &[String]) -> char {
    static SIDE: LazyLock<Regex> = LazyLock::new(|| rei(r"\s*\b(DR|CR)\.?$"));
    static COMMA: LazyLock<Regex> = LazyLock::new(|| re(r",\d{1,2}-?$"));
    static DOT: LazyLock<Regex> = LazyLock::new(|| re(r"\.\d{1,2}-?$"));
    let (mut comma, mut dot) = (0, 0);
    for raw in samples {
        let t = js::trim(raw);
        let t = SIDE.replace(t, "");
        let t = t.strip_suffix(')').unwrap_or(&t);
        if COMMA.is_match(t) {
            comma += 1;
        } else if DOT.is_match(t) {
            dot += 1;
        }
    }
    if dot > comma {
        '.'
    } else {
        ','
    }
}

// --------------------------------------------------------------------------------------- headers

/// `normHeader` of src/core/csv/read.ts.
pub fn norm_header(h: &str) -> String {
    static OTHER: LazyLock<Regex> = LazyLock::new(|| re(r"[^a-z0-9/ ()]+"));
    let folded: String = h.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let quotes: String = folded.chars().map(|c| if matches!(c, '’' | '\'' | '`') { ' ' } else { c }).collect();
    js::squash(&OTHER.replace_all(&quotes, " "))
}

/// The field a header name stands for (exact name first, then partial for longer names), or None. Fields are the keys
/// of the mapping: `bookingDate`, `valueDate`, `amount`, `description`, `ignore` and so on.
pub fn header_field(text: &str) -> Option<&'static str> {
    let h = norm_header(text);
    SYNONYMS
        .iter()
        .find(|(_, names)| names.contains(&h.as_str()))
        .or_else(|| {
            SYNONYMS.iter().find(|(f, names)| *f != "ignore" && names.iter().any(|syn| syn.chars().count() >= 5 && h.contains(syn)))
        })
        .map(|(f, _)| *f)
}

pub fn score_header_row(cells: &[&str]) -> usize {
    static ALL: LazyLock<HashSet<&'static str>> = LazyLock::new(|| SYNONYMS.iter().flat_map(|(_, n)| n.iter().copied()).collect());
    cells.iter().filter(|c| ALL.contains(norm_header(c).as_str())).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/csvrules.json")).unwrap()
    }

    #[test]
    fn dates_equal_the_typescript() {
        for c in fixtures()["dates"].as_array().unwrap() {
            let order = match c["order"].as_str().unwrap() {
                "DMY" => DateOrder::Dmy,
                "MDY" => DateOrder::Mdy,
                _ => DateOrder::Ymd,
            };
            let input = c["input"].as_str().unwrap();
            assert_eq!(parse_date(input, order).as_deref(), c["result"].as_str(), "parseDate({input:?}, {order:?})");
        }
    }

    #[test]
    fn amounts_equal_the_typescript() {
        for c in fixtures()["amounts"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            let decimal = c["decimal"].as_str().unwrap().chars().next();
            assert_eq!(parse_amount(input, decimal), c["result"].as_i64(), "parseAmount({input:?}, {decimal:?})");
        }
    }

    #[test]
    fn decimal_marks_and_headers_equal_the_typescript() {
        for c in fixtures()["decimals"].as_array().unwrap() {
            let samples: Vec<String> = c["samples"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
            assert_eq!(detect_decimal(&samples).to_string(), c["result"].as_str().unwrap(), "detectDecimal({samples:?})");
        }
        for c in fixtures()["headers"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            assert_eq!(norm_header(input), c["norm"].as_str().unwrap(), "normHeader({input:?})");
            assert_eq!(header_field(input), c["field"].as_str(), "headerField({input:?})");
            assert_eq!(score_header_row(&[input, input]), c["score"].as_u64().unwrap() as usize, "scoreHeaderRow({input:?})");
        }
    }
}
