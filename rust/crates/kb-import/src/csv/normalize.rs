//! Turns mapped CSV rows into clean transactions, recording every problem instead of guessing silently
//! (src/core/csv/normalize.ts).
use super::mapping::{direction_of, DateOrder, Mapping};
use crate::amount::parse_amount_with;
use crate::jsstr::{collapse_spaces, is_js_space, is_letter, js_number, js_trim, JS_SPACE};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowIssue {
    DateInvalid,
    AmountInvalid,
    AmountZero,
    StatusRefused,
    CurrencyOther,
}

impl RowIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DateInvalid => "date_invalid",
            Self::AmountInvalid => "amount_invalid",
            Self::AmountZero => "amount_zero",
            Self::StatusRefused => "status_refused",
            Self::CurrencyOther => "currency_other",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CleanRow {
    /// Index in the data rows (0 = first row after the header).
    pub index: usize,
    pub line: usize,
    pub booking_date: Option<String>,
    pub value_date: Option<String>,
    pub amount_cents: Option<i64>,
    pub currency: Option<String>,
    pub description: String,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub communication: Option<String>,
    pub bank_reference: Option<String>,
    /// The account balance after this transaction, when the file has it.
    pub balance_cents: Option<i64>,
    pub issues: Vec<RowIssue>,
}

/// What `MONTHS[word]` gives in TypeScript: a month, a name of `Object.prototype` (a function, which is no month but is not
/// `undefined` either), or nothing.
enum Month {
    Is(u32),
    Poison,
}

/// Month names and abbreviations in Kasboek's languages (accents removed), January = 1.
fn month_of(word: &str) -> Option<Month> {
    const NAMES: [&[&str]; 12] = [
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
    // The lower-case names an object literal has from `Object.prototype`.
    if matches!(word, "constructor" | "__proto__") {
        return Some(Month::Poison);
    }
    NAMES.iter().position(|names| names.contains(&word)).map(|i| Month::Is(i as u32 + 1))
}

fn is_digits(w: &str) -> bool {
    !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit())
}

/// "16 Nov 2026", "16-nov-26", "Nov 16, 2026", "16. November 2026": day, month name, year in any of these orders.
fn parse_named_date(text: &str) -> Option<(f64, f64, f64)> {
    let lowered: String = text.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let spaced: String = lowered.chars().map(|c| if matches!(c, '.' | ',') { ' ' } else { c }).collect();
    let words: Vec<&str> = spaced.split(|c: char| is_js_space(c) || c == '/' || c == '-').filter(|w| !w.is_empty()).collect();
    let month = words.iter().find_map(|w| month_of(w))?;
    let Month::Is(month) = month else { return None };
    let nums: Vec<f64> = words.iter().filter(|w| is_digits(w)).map(|w| js_number(w)).collect();
    if nums.len() < 2 {
        return None;
    }
    let year = nums.iter().copied().find(|n| *n > 31.0).unwrap_or(nums[1]);
    let day = nums.iter().copied().find(|n| *n != year && *n <= 31.0)?;
    Some((year, f64::from(month), day))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

static ISO_DATE_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T").expect("date-time regex"));

fn has_three_letters(text: &str) -> bool {
    let mut run = 0;
    for c in text.chars() {
        if is_letter(c) {
            run += 1;
            if run == 3 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// A date as `YYYY-MM-DD`, or `None` when it is not a real day between 1990 and 2100.
pub fn parse_date(text: &str, order: DateOrder) -> Option<String> {
    let trimmed = js_trim(text);
    let first = trimmed.split([' ', 'T']).next().unwrap_or("");
    let (mut y, m, d);
    if has_three_letters(text) && !ISO_DATE_TIME.is_match(trimmed) {
        (y, m, d) = parse_named_date(text)?;
    } else if first.len() == 8 && first.bytes().all(|b| b.is_ascii_digit()) {
        (y, m, d) = (js_number(&first[..4]), js_number(&first[4..6]), js_number(&first[6..]));
    } else {
        let parts: Vec<f64> = first.split(['-', '/', '.']).map(js_number).collect();
        if parts.len() != 3 || parts.iter().any(|n| !n.is_finite() || n.fract() != 0.0) {
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
    let whole = |n: f64| n.is_finite() && n.fract() == 0.0;
    if !(whole(y) && whole(m) && whole(d)) || !(1990.0..=2100.0).contains(&y) || !(1.0..=12.0).contains(&m) {
        return None;
    }
    let (y, m, d) = (y as i64, m as i64, d as i64);
    if d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some(format!("{y}-{m:02}-{d:02}"))
}

static STRUCTURED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:\+\+\+|\*\*\*)?[{s}]*([0-9]{{3}})[{s}]*/?[{s}]*([0-9]{{4}})[{s}]*/?[{s}]*([0-9]{{5}})[{s}]*(?:\+\+\+|\*\*\*)?",
        s = JS_SPACE
    ))
    .expect("structured communication regex")
});

/// Belgian structured communication (OGM/VCS): 12 digits, the last two are the first ten mod 97 (97 when 0). Returns the
/// canonical `+++123/4567/89012+++` form, or `None`.
pub fn structured_communication(text: &str) -> Option<String> {
    let m = STRUCTURED.captures(text)?;
    let digits = format!("{}{}{}", &m[1], &m[2], &m[3]);
    let first_ten: u64 = digits[..10].parse().ok()?;
    let check = match first_ten % 97 {
        0 => 97,
        n => n,
    };
    let given: u64 = digits[10..].parse().ok()?;
    (check == given).then(|| format!("+++{}/{}/{}+++", &m[1], &m[2], &m[3]))
}

fn clean(s: Option<&String>) -> String {
    js_trim(&collapse_spaces(s.map_or("", String::as_str))).to_owned()
}

/// A bank reference only when it identifies the transaction. Banks put a placeholder on payments that are still pending
/// (Hello bank!: "2026-", the number follows once booked); that counts as none.
pub fn real_reference(text: Option<&str>) -> Option<String> {
    let s = js_trim(text.unwrap_or(""));
    if s.is_empty() || s.chars().all(|c| matches!(c, '-' | '0' | '.' | '/') || is_js_space(c)) {
        return None;
    }
    // Only a year, with or without a separator: the number is still to come.
    let b = s.as_bytes();
    let year = b.len() >= 4 && matches!(&b[..2], b"19" | b"20") && b[2..4].iter().all(u8::is_ascii_digit);
    if year && (b.len() == 4 || (b.len() == 5 && matches!(b[4], b'-' | b'/' | b'.'))) {
        return None;
    }
    Some(s.to_owned())
}

fn is_refused(status: &str) -> bool {
    let s = status.to_ascii_lowercase();
    ["weiger", "refus", "reject", "annul", "cancel", "declin"].iter().any(|w| s.contains(w))
}

/// The rows after the header as clean transactions.
pub fn normalize_rows(raw_rows: &[Vec<String>], mapping: &Mapping, account_currency: &str) -> Vec<CleanRow> {
    let c = &mapping.columns;
    let data = raw_rows.get(mapping.header_row + 1..).unwrap_or_default();
    data.iter()
        .enumerate()
        .map(|(index, raw)| {
            let mut issues = Vec::new();
            let get = |i: Option<usize>| -> String { i.map_or_else(String::new, |i| clean(raw.get(i))) };

            let booking_date = parse_date(&get(Some(c.booking_date)), mapping.date_order);
            if booking_date.is_none() {
                issues.push(RowIssue::DateInvalid);
            }
            let value_date = c.value_date.and_then(|i| parse_date(&get(Some(i)), mapping.date_order));

            let mut amount_cents: Option<i64>;
            // An empty amount cell with debit/credit columns next to it (Deutsche Bank: "Betrag" empty, "Soll"/"Haben" filled).
            if c.amount.is_some() && (!get(c.amount).is_empty() || (c.debit.is_none() && c.credit.is_none())) {
                amount_cents = parse_amount_with(&get(c.amount), mapping.decimal);
            } else {
                let side = |i: Option<usize>| {
                    let text = get(i);
                    if text.is_empty() {
                        Some(0)
                    } else {
                        parse_amount_with(&text, mapping.decimal)
                    }
                };
                amount_cents = match (side(c.debit), side(c.credit)) {
                    // One rounding of the exact difference, as the doubles of JavaScript do.
                    (Some(debit), Some(credit)) => Some((credit as f64 - (debit.abs() as f64)) as i64),
                    _ => None,
                };
            }
            // A separate column says out or in ("Af"/"Bij", "S"/"H"); the amount itself is then usually without sign.
            if let (Some(cents), Some(_)) = (amount_cents, c.direction) {
                if let Some(dir) = direction_of(&get(c.direction)) {
                    amount_cents = Some(dir * cents.abs());
                }
            }
            if let (Some(cents), true) = (amount_cents, mapping.invert_sign) {
                amount_cents = Some(-cents);
            }
            match amount_cents {
                None => issues.push(RowIssue::AmountInvalid),
                Some(0) => issues.push(RowIssue::AmountZero),
                Some(_) => {}
            }

            let currency = Some(get(c.currency).to_uppercase()).filter(|s| !s.is_empty());
            if currency
                .as_deref()
                .is_some_and(|cur| cur.len() == 3 && cur.bytes().all(|b| b.is_ascii_uppercase()) && cur != account_currency)
            {
                issues.push(RowIssue::CurrencyOther);
            }

            let status = get(c.status);
            if !status.is_empty() && is_refused(&status) {
                issues.push(RowIssue::StatusRefused);
            }

            let mut desc_parts: Vec<String> = Vec::new();
            for i in &c.description {
                let part = get(Some(*i));
                if !part.is_empty() && !desc_parts.contains(&part) {
                    desc_parts.push(part);
                }
            }
            let mut communication = Some(get(c.communication)).filter(|s| !s.is_empty());
            let structured = structured_communication(communication.as_deref().unwrap_or(""))
                .or_else(|| structured_communication(&desc_parts.join(" ")));
            if let Some(s) = structured {
                communication = Some(s);
            }

            let iban_raw: String = get(c.counterparty_iban).chars().filter(|ch| !is_js_space(*ch)).collect::<String>().to_uppercase();
            let counterparty_name = Some(get(c.counterparty_name)).filter(|s| !s.is_empty());
            let description = Some(desc_parts.join(" · "))
                .filter(|s| !s.is_empty())
                .or_else(|| counterparty_name.clone())
                .or_else(|| communication.clone())
                .unwrap_or_default();
            CleanRow {
                index,
                line: mapping.header_row + index + 2,
                booking_date,
                value_date,
                amount_cents,
                currency,
                description,
                counterparty_name,
                counterparty_iban: Some(iban_raw).filter(|s| !s.is_empty()),
                communication,
                bank_reference: real_reference(Some(&get(c.bank_reference))),
                balance_cents: c
                    .balance
                    .and_then(|i| Some(get(Some(i))).filter(|t| !t.is_empty()).and_then(|t| parse_amount_with(&t, mapping.decimal))),
                issues,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates_and_rejects_impossible_ones() {
        assert_eq!(parse_date("03-10-2026", DateOrder::Dmy).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("2026-10-03", DateOrder::Ymd).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("31/02/2026", DateOrder::Dmy), None);
        assert_eq!(parse_date("20261003", DateOrder::Ymd).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("10/03/26", DateOrder::Mdy).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("2026-10-03T12:30:00", DateOrder::Ymd).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("2026-10-03 12:30", DateOrder::Ymd).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_date("29/02/2024", DateOrder::Dmy).as_deref(), Some("2024-02-29"));
        assert_eq!(parse_date("29/02/2100", DateOrder::Dmy), None);
        assert_eq!(parse_date("01/01/1989", DateOrder::Dmy), None);
        assert_eq!(parse_date("0x10-03-2026", DateOrder::Dmy).as_deref(), Some("2026-03-16"), "Number() reads hex");
    }

    #[test]
    fn parses_named_months_in_every_language() {
        assert_eq!(parse_date("16 Nov 2026", DateOrder::Dmy).as_deref(), Some("2026-11-16"));
        assert_eq!(parse_date("16-nov-26", DateOrder::Dmy).as_deref(), Some("2026-11-16"));
        assert_eq!(parse_date("Nov 16, 2026", DateOrder::Dmy).as_deref(), Some("2026-11-16"));
        assert_eq!(parse_date("16. März 2026", DateOrder::Dmy).as_deref(), Some("2026-03-16"));
        assert_eq!(parse_date("3 août 2026", DateOrder::Dmy).as_deref(), Some("2026-08-03"));
        assert_eq!(parse_date("3 constructor mar 2026", DateOrder::Dmy), None, "a name of Object.prototype is no month");
        assert_eq!(parse_date("3 mar constructor 2026", DateOrder::Dmy).as_deref(), Some("2026-03-03"));
        assert_eq!(parse_date("foo 2026", DateOrder::Dmy), None);
    }

    #[test]
    fn validates_structured_communications() {
        assert_eq!(structured_communication("+++090/9337/55493+++").as_deref(), Some("+++090/9337/55493+++"));
        assert_eq!(structured_communication("090933755493").as_deref(), Some("+++090/9337/55493+++"));
        assert_eq!(structured_communication("+++090/9337/55494+++"), None);
    }

    #[test]
    fn placeholders_are_no_references() {
        for none in ["", "0000", "2026-", "2026/", "- / .", "1999.", "2026"] {
            assert_eq!(real_reference(Some(none)), None, "{none:?}");
        }
        for some in ["2026-0001", "12345", "20267", "REF-9"] {
            assert_eq!(real_reference(Some(some)).as_deref(), Some(some));
        }
    }
}
