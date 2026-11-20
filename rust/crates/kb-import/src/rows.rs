//! The rows of an import (the pure part of `buildRows` in src/core/import.ts): each row's status (ready, duplicate, possible
//! duplicate, problem, skipped), the fingerprint it is recognised by, the category a rule gives, and the bank balance the file
//! ends with. The transactions already in Kasboek are reached through [`Ledger`].
use crate::csv::normalize::{CleanRow, RowIssue};
use crate::error::ImportError;
use crate::fingerprint::fingerprint;
use crate::group::group_key;
use crate::jsstr::js_trim;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Possibly the same payment: this many days apart at most, and this share of the shorter text's words in common.
const POSSIBLE_DAYS: i64 = 3;
const POSSIBLE_SIMILARITY: f64 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Include,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CategorySource {
    User,
    Assistant,
    Rule,
}

/// What the person (or the assistant) changed in a row. `None` leaves a field alone; `Some(None)` is an explicit `null`.
#[derive(Debug, Clone, Default)]
pub struct RowOverride {
    pub decided: Option<Option<Decision>>,
    pub category_id: Option<Option<i64>>,
    pub category_source: Option<CategorySource>,
    pub booking_date: Option<String>,
    pub amount_cents: Option<i64>,
    pub description: Option<String>,
    pub counterparty_name: Option<Option<String>>,
    pub note: Option<Option<String>>,
}

impl RowOverride {
    /// `{...prev, ...change}`: every field the change has replaces the old one.
    pub fn merge(&mut self, change: RowOverride) {
        fn set<T>(slot: &mut Option<T>, value: Option<T>) {
            if value.is_some() {
                *slot = value;
            }
        }
        set(&mut self.decided, change.decided);
        set(&mut self.category_id, change.category_id);
        set(&mut self.category_source, change.category_source);
        set(&mut self.booking_date, change.booking_date);
        set(&mut self.amount_cents, change.amount_cents);
        set(&mut self.description, change.description);
        set(&mut self.counterparty_name, change.counterparty_name);
        set(&mut self.note, change.note);
    }
}

/// A readable name and description an earlier import gave to a bank text.
#[derive(Debug, Clone)]
pub struct Learned {
    pub name: Option<String>,
    pub description: String,
}

/// A transaction already in Kasboek, as far as duplicate detection looks at it.
#[derive(Debug, Clone)]
pub struct Existing {
    pub id: i64,
    pub booking_date: String,
    pub counterparty_name: Option<String>,
    pub description: String,
    pub bank_counterparty: Option<String>,
    pub bank_description: Option<String>,
    pub bank_reference: Option<String>,
    pub fingerprint: Option<String>,
}

/// The transactions of one account already in Kasboek, each list by id.
pub trait Ledger {
    type Error: From<ImportError>;
    fn by_fingerprint(&self, account_id: i64, fingerprint: &str) -> Result<Vec<Existing>, Self::Error>;
    fn by_reference(&self, account_id: i64, reference: &str) -> Result<Vec<Existing>, Self::Error>;
    /// The same amount between two dates (inclusive).
    fn nearby(&self, account_id: i64, amount_cents: i64, from: &str, to: &str) -> Result<Vec<Existing>, Self::Error>;
}

/// The text of a row a rule looks at.
pub struct RuleView<'a> {
    pub counterparty_name: Option<&'a str>,
    pub description: &'a str,
    pub counterparty_iban: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMatch {
    pub id: i64,
    pub booking_date: String,
    pub counterparty_name: Option<String>,
    pub description: String,
}

/// `ImportRow` of src/shared/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub index: usize,
    pub line: usize,
    pub booking_date: Option<String>,
    pub amount_cents: Option<i64>,
    pub description: String,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub communication: Option<String>,
    pub category_id: Option<i64>,
    pub category_source: Option<CategorySource>,
    pub issues: Vec<&'static str>,
    pub status: &'static str,
    pub decided: Option<Decision>,
    pub note: Option<String>,
    #[serde(rename = "match")]
    pub matched: Option<RowMatch>,
}

/// A row as it will be imported (`clean`, with the changes made to it), as the file had it (`raw`), and as the preview shows it.
pub struct Built {
    pub clean: CleanRow,
    pub raw: CleanRow,
    pub row: ImportRow,
    pub fingerprint: Option<String>,
}

static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").expect("word regex"));
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{M}").expect("mark regex"));

/// Words of a bank text, for comparing two texts that may be worded a little differently.
fn tokens(text: &str) -> HashSet<String> {
    let folded: String = text.to_lowercase().nfkd().collect();
    let plain = MARKS.replace_all(&folded, "");
    NON_WORD
        .split(&plain)
        // `w.length >= 2` counts UTF-16 units; digits only is `/^\d+$/`.
        .filter(|w| w.encode_utf16().count() >= 2 && !w.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_owned)
        .collect()
}

/// Share of the shorter text's words that also appear in the other.
pub fn similarity(a: &str, b: &str) -> f64 {
    let x = tokens(a);
    let y = tokens(b);
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let common = x.iter().filter(|w| y.contains(*w)).count();
    common as f64 / x.len().min(y.len()) as f64
}

/// Days since 1970-01-01 of a civil date (the month may be 1 to 12 and the day beyond the month's end).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + d - 1
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `new Date(date + 'T00:00:00Z')`, `setUTCDate(day + days)`, `toISOString().slice(0, 10)`. The parser of the engine takes a
/// day from 1 to 31 in any month (February 30 is March 2); a month or day outside that is an invalid date, which throws.
fn shift_date(date: &str, days: i64) -> Result<String, ImportError> {
    let b = date.as_bytes();
    let well_formed = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    let number = |from: usize, to: usize| date[from..to].parse::<i64>().unwrap_or(0);
    if !well_formed || !(1..=12).contains(&number(5, 7)) || !(1..=31).contains(&number(8, 10)) {
        return Err(ImportError::failed());
    }
    let (y, m, d) = civil_from_days(days_from_civil(number(0, 4), number(5, 7), number(8, 10)) + days);
    let text = if (0..=9999).contains(&y) {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{}{:06}-{m:02}-{d:02}", if y < 0 { '-' } else { '+' }, y.abs())
    };
    Ok(text.chars().take(10).collect())
}

/// A bank reference only when it identifies the transaction (see `real_reference`).
fn real_reference(text: Option<&str>) -> bool {
    crate::csv::normalize::real_reference(text).is_some()
}

fn rule_view(r: &CleanRow) -> RuleView<'_> {
    RuleView {
        counterparty_name: r.counterparty_name.as_deref(),
        description: &r.description,
        counterparty_iban: r.counterparty_iban.as_deref(),
    }
}

/// The rows of a file with the changes the person made, their status, and what each one matches in the account.
///
/// Duplicates are recognised on the bank's own text, so a cleaned-up name or description still matches the same transaction
/// imported earlier (only corrected dates and amounts count). `rule` gives the category of the first rule that matches.
pub fn build_rows<L: Ledger>(
    ledger: &L,
    account_id: i64,
    clean: Vec<CleanRow>,
    overrides: &HashMap<usize, RowOverride>,
    learned: &HashMap<String, Learned>,
    rule: &dyn Fn(&RuleView<'_>) -> Option<i64>,
) -> Result<Vec<Built>, L::Error> {
    // A bank reference identifies one transaction only if it is unique in this file (some banks repeat a statement number on
    // every line).
    let mut ref_count: HashMap<&str, usize> = HashMap::new();
    for c in &clean {
        if let Some(r) = c.bank_reference.as_deref().map(js_trim).filter(|r| !r.is_empty()) {
            *ref_count.entry(r).or_insert(0) += 1;
        }
    }
    let ref_count: HashMap<String, usize> = ref_count.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    let mut seen: HashMap<String, usize> = HashMap::new();
    // Transactions already matched by an earlier row: each one is matched at most once.
    let mut claimed: HashSet<i64> = HashSet::new();
    let none = RowOverride::default();
    let mut results = Vec::with_capacity(clean.len());
    for c in clean {
        let o = overrides.get(&c.index).unwrap_or(&none);
        let known = if learned.is_empty() {
            None
        } else {
            learned.get(&group_key(
                c.counterparty_name.as_deref(),
                &c.description,
                c.amount_cents,
                c.communication.as_deref(),
                c.counterparty_iban.as_deref(),
            ))
        };
        let merged = CleanRow {
            booking_date: o.booking_date.clone().or_else(|| c.booking_date.clone()),
            amount_cents: o.amount_cents.or(c.amount_cents),
            description: o.description.clone().or_else(|| known.map(|k| k.description.clone())).unwrap_or_else(|| c.description.clone()),
            counterparty_name: match (&o.counterparty_name, known) {
                (Some(name), _) => name.clone(),
                (None, Some(k)) => k.name.clone(),
                (None, None) => c.counterparty_name.clone(),
            },
            issues: Vec::new(),
            ..c.clone()
        };
        let mut fp: Option<String> = None;
        let mut matched: Option<Existing> = None;
        // An overridden date or (non-zero) amount settles the issue the file's own cell had.
        let issues: Vec<RowIssue> = c
            .issues
            .iter()
            .copied()
            .filter(|i| {
                !(*i == RowIssue::DateInvalid && o.booking_date.as_deref().is_some_and(|d| !d.is_empty()))
                    && !(matches!(i, RowIssue::AmountInvalid | RowIssue::AmountZero) && o.amount_cents.is_some_and(|a| a != 0))
            })
            .collect();
        let mut status = "ready";
        if issues.iter().any(|i| *i != RowIssue::CurrencyOther) {
            status = if issues.contains(&RowIssue::StatusRefused) { "skipped" } else { "problem" };
        } else if let (Some(date), Some(amount)) = (merged.booking_date.as_deref().filter(|d| !d.is_empty()), merged.amount_cents) {
            let key =
                fingerprint(account_id, date, amount, c.counterparty_name.as_deref(), Some(&c.description), c.bank_reference.as_deref());
            let reference = c.bank_reference.as_deref().map(js_trim).filter(|r| !r.is_empty());
            // 1. The same bank reference: the same transaction, whatever the text says now.
            if let Some(r) = reference {
                if ref_count.get(r) == Some(&1) {
                    matched = ledger.by_reference(account_id, r)?.into_iter().find(|e| !claimed.contains(&e.id));
                }
            }
            // 2. The same date, amount and text. The n-th copy counts as a duplicate only if the account already has n of
            // them (two identical coffees on one day are both real).
            if matched.is_none() {
                let nth = seen.get(&key).copied().unwrap_or(0) + 1;
                seen.insert(key.clone(), nth);
                let same = ledger.by_fingerprint(account_id, &key)?;
                if same.len() >= nth {
                    matched = same.iter().find(|e| !claimed.contains(&e.id)).or_else(|| same.get(nth - 1)).cloned();
                }
            }
            // 2b. Imported earlier while still pending, before the bank gave it a reference: the same transaction without
            // the reference.
            if matched.is_none() && reference.is_some() {
                let pending = fingerprint(account_id, date, amount, c.counterparty_name.as_deref(), Some(&c.description), None);
                matched = ledger
                    .by_fingerprint(account_id, &pending)?
                    .into_iter()
                    .find(|e| !claimed.contains(&e.id) && e.bank_reference.as_deref().is_none_or(str::is_empty));
            }
            if matched.is_some() {
                status = "duplicate";
            } else {
                // 3. Possibly the same: same amount a few days apart with similar text (the bank reworded it, or moved the
                // date). The person (or Check) decides.
                let text = format!("{} {}", c.counterparty_name.as_deref().unwrap_or(""), c.description);
                let candidates =
                    ledger.nearby(account_id, amount, &shift_date(date, -POSSIBLE_DAYS)?, &shift_date(date, POSSIBLE_DAYS)?)?;
                matched = candidates.into_iter().find(|e| {
                    !claimed.contains(&e.id)
                        && e.fingerprint.as_deref() != Some(key.as_str())
                        // A different reference means a different payment, but only when it is a real one.
                        && !(reference.is_some_and(|r| real_reference(e.bank_reference.as_deref()) && e.bank_reference.as_deref().map(js_trim) != Some(r)))
                        // Compared with the bank's own text, as the new row's text is too.
                        && similarity(
                            &text,
                            &format!(
                                "{} {}",
                                e.bank_counterparty.as_deref().or(e.counterparty_name.as_deref()).unwrap_or(""),
                                e.bank_description.as_deref().unwrap_or(&e.description)
                            ),
                        ) >= POSSIBLE_SIMILARITY
                });
                if matched.is_some() {
                    status = "possible_duplicate";
                }
            }
            if let Some(m) = &matched {
                claimed.insert(m.id);
            }
            fp = Some(key);
        }
        if o.decided == Some(Some(Decision::Skip)) {
            status = "skipped";
        }
        if o.decided == Some(Some(Decision::Include)) && status != "problem" {
            status = "ready";
        }
        // Rules match the cleaned-up text or the bank's own.
        let rule_id = if o.category_id.is_none() { rule(&rule_view(&merged)).or_else(|| rule(&rule_view(&c))) } else { None };
        let mut row_issues: Vec<&'static str> = issues.iter().map(|i| i.as_str()).collect();
        if status == "possible_duplicate" {
            row_issues.push("possible_duplicate");
        }
        let row = ImportRow {
            index: c.index,
            line: c.line,
            booking_date: merged.booking_date.clone(),
            amount_cents: merged.amount_cents,
            description: merged.description.clone(),
            counterparty_name: merged.counterparty_name.clone(),
            counterparty_iban: merged.counterparty_iban.clone(),
            communication: merged.communication.clone(),
            category_id: match o.category_id {
                Some(chosen) => chosen,
                None => rule_id,
            },
            category_source: match o.category_id {
                Some(_) => Some(o.category_source.unwrap_or(CategorySource::User)),
                None => rule_id.map(|_| CategorySource::Rule),
            },
            issues: row_issues,
            status,
            decided: o.decided.flatten(),
            note: o.note.clone().flatten(),
            matched: matched.map(|m| RowMatch {
                id: m.id,
                booking_date: m.booking_date,
                counterparty_name: m.counterparty_name,
                description: m.description,
            }),
        };
        results.push(Built { clean: merged, raw: c, row, fingerprint: fp });
    }
    Ok(results)
}

/// The balance at the end of the file's last day, from a balance column: the balance after that day's last transaction (files
/// list either the newest or the oldest first). `(booking date, balance after)` per row, in file order.
pub fn file_balance(rows: &[(Option<&str>, Option<i64>)]) -> Option<(String, i64)> {
    let dated: Vec<(&str, Option<i64>)> = rows.iter().filter_map(|(d, b)| d.filter(|d| !d.is_empty()).map(|d| (d, *b))).collect();
    if !dated.iter().any(|(_, b)| b.is_some()) {
        return None;
    }
    let newest_first = dated.len() > 1 && dated[0].0 > dated[dated.len() - 1].0;
    let last = dated.iter().fold("", |m, (d, _)| if *d > m { d } else { m });
    let same_day: Vec<i64> = dated.iter().filter(|(d, _)| *d == last).filter_map(|(_, b)| *b).collect();
    let row = if newest_first { same_day.first() } else { same_day.last() };
    row.map(|cents| (last.to_owned(), *cents))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_texts_share_most_words() {
        assert_eq!(similarity("Delhaize Gent 12", "DELHAIZE GENT"), 1.0);
        assert_eq!(similarity("Café Brugge", "Cafe Brugge Centrum"), 1.0);
        assert_eq!(similarity("ab cd", "ab xy"), 0.5);
        assert_eq!(similarity("1234 56", "1234"), 0.0, "numbers are no words");
        assert_eq!(similarity("", "abc"), 0.0);
        assert_eq!(similarity("x", "x"), 0.0, "single letters are no words");
    }

    #[test]
    fn dates_shift_like_the_engines_date() {
        assert_eq!(shift_date("2026-03-01", -3).unwrap(), "2026-02-26");
        assert_eq!(shift_date("2026-12-30", 3).unwrap(), "2027-01-02");
        assert_eq!(shift_date("2024-03-01", -1).unwrap(), "2024-02-29");
        assert_eq!(shift_date("2026-02-30", 0).unwrap(), "2026-03-02", "a day past the month's end rolls over");
        assert_eq!(shift_date("2026-04-31", 3).unwrap(), "2026-05-04");
        assert_eq!(shift_date("9999-12-31", 3).unwrap(), "+010000-01");
        assert_eq!(shift_date("0000-01-01", -3).unwrap(), "-000001-12");
        for bad in ["2026-13-01", "2026-00-10", "2026-02-00", "2026-01-32"] {
            assert_eq!(shift_date(bad, 1).unwrap_err().code, "op.failed", "{bad}");
        }
    }

    #[test]
    fn the_balance_of_the_last_day() {
        let oldest_first = [(Some("2026-03-01"), Some(100)), (Some("2026-03-02"), Some(90)), (Some("2026-03-02"), Some(80))];
        assert_eq!(file_balance(&oldest_first), Some(("2026-03-02".into(), 80)));
        let newest_first = [(Some("2026-03-02"), Some(80)), (Some("2026-03-02"), Some(90)), (Some("2026-03-01"), Some(100))];
        assert_eq!(file_balance(&newest_first), Some(("2026-03-02".into(), 80)));
        assert_eq!(file_balance(&[(Some("2026-03-01"), None)]), None);
        assert_eq!(file_balance(&[(Some("2026-03-01"), Some(5)), (Some("2026-03-02"), None)]), None, "the last day has no balance");
        assert_eq!(file_balance(&[(None, Some(5))]), None);
    }
}
