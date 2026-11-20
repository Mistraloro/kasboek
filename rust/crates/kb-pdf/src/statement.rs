//! Reads the table of a bank statement out of PDF lines and returns it as a plain grid of text (header row first), the way
//! a CSV file would be read, so the normal import does the rest (columns, dates, number formats, debit/credit,
//! duplicates). Amounts are never computed here: the grid only holds text that is in the PDF (a missing year is the one
//! thing filled in, from the statement period). Port of src/core/pdf/statement.ts, with `reconcile` and the banner of
//! src/shared/pdf-import.ts.
use crate::csvrules::{detect_decimal, header_field, parse_amount, parse_date, score_header_row, DateOrder};
use crate::js::{self, lower_plain, re, rei};
use crate::lines::{PdfCell, PdfLine};
use kb_rules::iban::{find_ibans, mask_iban};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct StatementPeriod {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct StatementBalances {
    pub opening: Option<i64>,
    pub closing: Option<i64>,
}

/// Remarks about the statement, as codes the screen words in the person's language.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum StatementNote {
    OtherAccount { iban: String },
    DatesWithoutYear,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StatementRead {
    /// Header row first; empty when no table of transactions was found.
    pub grid: Vec<Vec<String>>,
    #[serde(rename = "headerFound")]
    pub header_found: bool,
    pub balances: StatementBalances,
    pub period: StatementPeriod,
    pub notes: Vec<StatementNote>,
    /// Lines inside the table that are neither a transaction nor part of one (page numbers, footers).
    #[serde(rename = "droppedLines")]
    pub dropped_lines: usize,
}

/// Text without accents or capitals, punctuation as single spaces.
fn fold(s: &str) -> String {
    static OTHER: LazyLock<Regex> = LazyLock::new(|| re(r"[^a-z0-9]+"));
    OTHER.replace_all(&lower_plain(s), " ").trim_matches(' ').to_string()
}

fn lower(s: &str) -> String {
    lower_plain(s)
}

// ---------------------------------------------------------------------------------------- dates

fn parse_any(text: &str) -> Option<String> {
    parse_date(text, DateOrder::Dmy).or_else(|| parse_date(text, DateOrder::Mdy)).or_else(|| parse_date(text, DateOrder::Ymd))
}

static YEARLESS_NUMBER: LazyLock<Regex> = LazyLock::new(|| re(r"^(\d{1,2})([./-])(\d{1,2})[./-]?$"));
static YEARLESS_NAMED: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:\d{1,2}\.?\s?[A-Za-zÀ-ÿ]{3,9}|[A-Za-zÀ-ÿ]{3,9}\.?\s\d{1,2})\.?$"));

/// A date written without a year: how to write it with one, and its month.
struct Yearless {
    body: String,
    /// The separator of a numeric date ("03/11": "/"), None for a named one.
    separator: Option<String>,
    month: i64,
}

impl Yearless {
    fn with_year(&self, year: i64) -> String {
        match &self.separator {
            Some(sep) => format!("{}{}{}", self.body, sep, year),
            None => format!("{} {}", self.body, year),
        }
    }
}

/// A date written without a year, or None for anything else.
fn yearless(date_text: &str) -> Option<Yearless> {
    static TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"[./-]$"));
    let text = js::trim(date_text);
    let number = YEARLESS_NUMBER.captures(text);
    if number.is_none() && !YEARLESS_NAMED.is_match(text) {
        return None;
    }
    let body = TAIL.replace(text, "").to_string();
    let found = Yearless { body, separator: number.map(|n| n[2].to_string()), month: 0 };
    let probe = parse_any(&found.with_year(2000))?;
    Some(Yearless { month: probe[5..7].parse().unwrap_or(0), ..found })
}

/// Adds the year to a date written without one ("03/11", "03 NOV"), from the statement period: the year of the period's
/// end, or the year before when the month is after the end's month (a statement from December to January). Text that
/// has a year, or is no date, is returned as it is.
pub fn complete_year(date_text: &str, period: &StatementPeriod) -> String {
    let Some(parts) = yearless(date_text) else { return date_text.to_string() };
    let Some(end) = period.to.as_ref().or(period.from.as_ref()) else { return date_text.to_string() };
    let mut it = end.split('-').map(|n| n.parse::<i64>().unwrap_or(0));
    let (end_year, end_month) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    // Only a start is known: the statement runs forward from it.
    let year = if period.to.is_some() {
        if parts.month > end_month {
            end_year - 1
        } else {
            end_year
        }
    } else if parts.month < end_month {
        end_year + 1
    } else {
        end_year
    };
    parts.with_year(year)
}

/// The date text of a cell with its year filled in, or None when the cell is no date.
fn date_of(text: &str, period: &StatementPeriod) -> Option<String> {
    let full = complete_year(text, period);
    parse_any(&full).map(|_| full)
}

const DATE: &str =
    r"(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s?[a-z]{3,9}\.?\s?\d{2,4}|[a-z]{3,9}\.?\s\d{1,2},?\s\d{4})";
const UP_TO: &str = r"(?:to|au|bis|tot|t/m|hasta|ate)";

static PERIOD_WITH_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?:from|du|vom|van|desde|del?|periode|period|periodo|zeitraum|von|between|entre)\s*:?\s*{DATE}\s*(?:{UP_TO}|a|al|and|et|und|en|y|e|-|–|—)\s*{DATE}"
    ))
});
static PERIOD_WITHOUT_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"{DATE}\s*{UP_TO}\s*{DATE}")));

fn period_of(text: &str) -> Option<StatementPeriod> {
    let m = PERIOD_WITH_PREFIX.captures(text).or_else(|| PERIOD_WITHOUT_PREFIX.captures(text))?;
    let (a, b) = (m.get(1)?.as_str(), m.get(2)?.as_str());
    // Day first, month first or year first: the order that puts the start before the end.
    for order in [DateOrder::Dmy, DateOrder::Mdy, DateOrder::Ymd] {
        if let (Some(from), Some(to)) = (parse_date(a, order), parse_date(b, order)) {
            if from <= to {
                return Some(StatementPeriod { from: Some(from), to: Some(to) });
            }
        }
    }
    None
}

// ------------------------------------------------------------------------------------ balances

const OPENING: &[&str] = &[
    "opening balance",
    "starting balance",
    "beginning balance",
    "previous balance",
    "balance at start",
    "beginsaldo",
    "begin saldo",
    "oud saldo",
    "vorig saldo",
    "saldo vorig afschrift",
    "saldo vorige",
    "solde precedent",
    "solde initial",
    "solde de depart",
    "ancien solde",
    "solde debut",
    "alter kontostand",
    "anfangssaldo",
    "anfangsbestand",
    "saldo anterior",
    "saldo inicial",
    "saldo anteriore",
    "saldo iniziale",
];
const CLOSING: &[&str] = &[
    "closing balance",
    "ending balance",
    "final balance",
    "new balance",
    "balance at end",
    "eindsaldo",
    "eind saldo",
    "nieuw saldo",
    "slotsaldo",
    "solde final",
    "nouveau solde",
    "solde fin",
    "solde de cloture",
    "neuer kontostand",
    "endsaldo",
    "schlusssaldo",
    "saldo final",
    "saldo actual",
    "saldo atual",
    "saldo nuevo",
    "saldo finale",
];
/// Carry-forward lines at a page's end and start: neither a transaction nor a statement balance.
const CARRY_PHRASES: &[&str] = &[
    "brought forward",
    "carried forward",
    "carry forward",
    "balance forward",
    "a reporter",
    "suma y sigue",
    "over te dragen",
    "a transportar",
    "saldo transportado",
];
/// Words that are carry-forward lines only when they are all the line says ("Ubertrag auf Sparkonto" is a payment).
const CARRY_WORDS: &[&str] = &["transport", "transporte", "report", "ubertrag", "overdracht"];

fn has_phrase(folded: &str, phrase: &str) -> bool {
    format!(" {folded} ").contains(&format!(" {phrase} "))
}

static DATE_CELL: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$"));
static AMOUNT_CELL: LazyLock<Regex> =
    LazyLock::new(|| rei(r"^[-+(]?\s*(?:[A-Z]{3}\s*|[€$£]\s*)?[-+]?\d[\d., '’]*[.,]\d{2}\s*\)?-?(?:\s*(?:CR|DR))?(?:\s*[A-Z]{3})?$"));
static AMOUNT_AT_END: LazyLock<Regex> =
    LazyLock::new(|| rei(r"(?:^|\s)([-+(]?\s*(?:[A-Z]{3}\s*|[€$£]\s*)?[-+]?\d{1,3}(?:[., '’]\d{3})*[.,]\d{2}\s*\)?-?(?:\s*(?:CR|DR))?)$"));

pub(crate) fn is_amount_text(text: &str) -> bool {
    let t = js::trim(text);
    AMOUNT_CELL.is_match(t) && !DATE_CELL.is_match(t)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Opening,
    Closing,
}

struct KeywordLine {
    found: Vec<(Kind, Option<String>)>,
}

/// What a line says about balances, or None when it holds no balance keyword.
fn keyword_line(line: &PdfLine) -> Option<KeywordLine> {
    static DIGITS: LazyLock<Regex> = LazyLock::new(|| re(r"^\d+$"));
    // A carry-forward line: all that is left of it, without dates and numbers, is the keyword.
    let joined = line
        .cells
        .iter()
        .filter(|c| !is_amount_text(&c.text) && !DATE_CELL.is_match(&c.text))
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let label = fold(&joined).split(' ').filter(|w| !DIGITS.is_match(w)).collect::<Vec<_>>().join(" ");
    let dated = line.cells.iter().any(|c| parse_any(&c.text).is_some());
    if (!dated && CARRY_WORDS.contains(&label.as_str())) || CARRY_PHRASES.iter().any(|p| has_phrase(&label, p)) {
        return Some(KeywordLine { found: Vec::new() });
    }
    let mut found = Vec::new();
    let mut segment: Option<(Kind, Vec<&str>)> = None;
    let close = |segment: &mut Option<(Kind, Vec<&str>)>, found: &mut Vec<(Kind, Option<String>)>| {
        if let Some((kind, cells)) = segment.take() {
            let whole = cells.iter().rev().find(|c| is_amount_text(c)).map(|c| c.to_string());
            // "Opening balance 1,000.00" in one cell.
            let trailing = AMOUNT_AT_END.captures(cells[0]).map(|m| m[1].to_string());
            found.push((kind, whole.or(trailing)));
        }
    };
    for cell in &line.cells {
        let f = fold(&cell.text);
        let kind = if OPENING.iter().any(|k| has_phrase(&f, k)) {
            Some(Kind::Opening)
        } else if CLOSING.iter().any(|k| has_phrase(&f, k)) {
            Some(Kind::Closing)
        } else {
            None
        };
        if let Some(kind) = kind {
            close(&mut segment, &mut found);
            segment = Some((kind, vec![cell.text.as_str()]));
        } else if let Some((_, cells)) = segment.as_mut() {
            cells.push(&cell.text);
        }
    }
    close(&mut segment, &mut found);
    if found.is_empty() {
        None
    } else {
        Some(KeywordLine { found })
    }
}

// --------------------------------------------------------------------------------------- columns

/// Columns that hold dates, amounts and the like: a continuation of a description has nothing in them.
const STRUCTURED: &[&str] = &["bookingDate", "valueDate", "amount", "debit", "credit", "direction", "balance", "currency", "status"];

/// The column a cell belongs to: the one whose header it overlaps most, else the nearest.
fn column_of(cell: &PdfCell, columns: &[PdfCell]) -> usize {
    let (mut best, mut best_score) = (0, f64::NEG_INFINITY);
    for (i, col) in columns.iter().enumerate() {
        let score = cell.x1.min(col.x1) - cell.x0.max(col.x0);
        if score > best_score {
            best = i;
            best_score = score;
        }
    }
    best
}

fn cell_texts(line: &PdfLine) -> Vec<&str> {
    line.cells.iter().map(|c| c.text.as_str()).collect()
}

pub fn is_header_line(line: &PdfLine) -> bool {
    let texts = cell_texts(line);
    if texts.len() < 2 || score_header_row(&texts) < 2 {
        return false;
    }
    texts.iter().any(|t| matches!(header_field(t), Some("bookingDate" | "valueDate")))
}

fn same_header(a: &PdfLine, b: &PdfLine) -> bool {
    a.cells.len() == b.cells.len() && a.cells.iter().zip(&b.cells).all(|(x, y)| fold(&x.text) == fold(&y.text))
}

/// The middle value, the lower one of the two for an even count (the usual step between lines, not a gap before a footer).
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if values.is_empty() {
        0.0
    } else {
        values[(values.len() - 1) / 2]
    }
}

/// The steps between lines that follow each other on a page, top down.
fn steps(lines: &[&PdfLine]) -> Vec<f64> {
    lines.windows(2).filter(|w| w[0].page == w[1].page && w[0].y > w[1].y).map(|w| w[0].y - w[1].y).collect()
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

// ------------------------------------------------------------------------- page headers and footers

/// A line this close to the top or bottom edge (as a share of the page) can be a header or footer.
const MARGIN: f64 = 0.12;

/// Lines that the pages repeat in their margins at the same height (a title, an address, "page 2 of 7", the print date):
/// the text is the same once its numbers are ignored (page 2 of 7, page 12 of 71). Lines with an amount never count.
fn margin_lines(lines: &[PdfLine]) -> HashSet<usize> {
    static NUMBERS: LazyLock<Regex> = LazyLock::new(|| re(r"\d+"));
    let pages = lines.iter().map(|l| l.page).collect::<HashSet<_>>().len();
    // Insertion order does not matter: the result is a set.
    let mut seen: HashMap<String, (HashSet<usize>, Vec<usize>)> = HashMap::new();
    for line in lines {
        let height = line.page_height.unwrap_or(0.0);
        if height == 0.0 || line.y.min(height - line.y) > height * MARGIN || line.cells.iter().any(|c| is_amount_text(&c.text)) {
            continue;
        }
        let texts: Vec<String> = line.cells.iter().map(|c| NUMBERS.replace_all(&c.text, "0").to_string()).collect();
        let key = format!("{}|{}", js_round(line.y) as i64, texts.join("|"));
        let entry = seen.entry(key).or_default();
        entry.0.insert(line.page);
        entry.1.push(line.id);
    }
    let need = 2.max(pages.div_ceil(2));
    seen.values().filter(|(p, _)| p.len() >= need).flat_map(|(_, ids)| ids.iter().copied()).collect()
}

// ------------------------------------------------------------------------------------ block layouts

/// A date as one cell, with or without a year.
fn is_date_cell(text: &str) -> bool {
    static ISO: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{4}-\d{2}-\d{2}$"));
    static NAMED: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{2,4}$"));
    DATE_CELL.is_match(text) || ISO.is_match(text) || NAMED.is_match(text) || yearless(text).is_some()
}

pub fn is_month_name(text: &str) -> bool {
    static NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-zÀ-ÿ]{3,9}\.?$"));
    NAME.is_match(text) && parse_any(&format!("1 {text} 2000")).is_some()
}

/// Every match of `pattern` (which must start with a capture group) that is not glued to digits: the text of group 1.
/// Stands for the look-behind and look-ahead of `(?<!\d)(...)(?!\d)`, which the regex engine has not.
fn standalone(pattern: &Regex, text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut at = 0;
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if i < at {
            prev = Some(c);
            continue;
        }
        if c.is_ascii_digit() && !prev.is_some_and(|p| p.is_ascii_digit()) {
            if let Some(m) = pattern.captures(&text[i..]) {
                let whole = m.get(0).expect("group 0");
                if !text[i + whole.end()..].chars().next().is_some_and(|n| n.is_ascii_digit()) {
                    found.push(m[1].to_string());
                    at = i + whole.end();
                }
            }
        }
        prev = Some(c);
    }
    found
}

static SIGNED: LazyLock<Regex> = LazyLock::new(|| rei(r"^[-+(]|-$|\b(?:CR|DR)\b"));

#[derive(Clone)]
struct Amount {
    text: String,
    cells: usize,
}

/// The amounts at the end of a line (up to two, left to right) and how many cells they take; a currency code in a cell of
/// its own goes with its amount.
fn trailing_amounts(line: &PdfLine) -> Vec<Amount> {
    static CURRENCY: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Z]{3}$"));
    let mut found: Vec<Amount> = Vec::new();
    let mut end = line.cells.len();
    while end > 0 && found.len() < 2 {
        let last = &line.cells[end - 1];
        let before = end.checked_sub(2).map(|i| &line.cells[i]);
        match before {
            Some(b) if CURRENCY.is_match(&last.text) && is_amount_text(&b.text) => {
                found.insert(0, Amount { text: format!("{} {}", b.text, last.text), cells: 2 });
                end -= 2;
            }
            _ if is_amount_text(&last.text) => {
                found.insert(0, Amount { text: last.text.clone(), cells: 1 });
                end -= 1;
            }
            _ => break,
        }
    }
    found
}

struct Block<'a> {
    lines: Vec<&'a PdfLine>,
    amounts: Vec<Amount>,
}

struct BlockDate {
    date: Option<String>,
    /// The cells the date was read from: (line in the block, cell in the line).
    used: HashSet<(usize, usize)>,
    yearless: bool,
}

/// The date a block prints: one cell, or a day with its month name in another (as "17" above "NOV"). None when there is none.
fn block_date(block: &Block, period: &StatementPeriod) -> BlockDate {
    static DAY: LazyLock<Regex> = LazyLock::new(|| re(r"^\d{1,2}$"));
    let cells: Vec<(usize, usize, &PdfCell)> =
        block.lines.iter().enumerate().flat_map(|(l, line)| line.cells.iter().enumerate().map(move |(i, c)| (l, i, c))).collect();
    if let Some(&(l, i, cell)) = cells.iter().find(|(_, _, c)| is_date_cell(&c.text)) {
        let date = date_of(&cell.text, period);
        let yl = date.is_none() && yearless(&cell.text).is_some();
        return BlockDate { date, used: HashSet::from([(l, i)]), yearless: yl };
    }
    let none = BlockDate { date: None, used: HashSet::new(), yearless: false };
    let Some(day_at) =
        cells.iter().position(|(_, i, c)| *i == 0 && DAY.is_match(&c.text) && (1..=31).contains(&c.text.parse::<u32>().unwrap_or(0)))
    else {
        return none;
    };
    let Some(month_at) = cells[day_at + 1..].iter().position(|(_, _, c)| is_month_name(&c.text)).map(|p| p + day_at + 1) else {
        return none;
    };
    let (day, month) = (cells[day_at], cells[month_at]);
    let date = date_of(&format!("{} {}", day.2.text, month.2.text), period);
    BlockDate { yearless: date.is_none(), date, used: HashSet::from([(day.0, day.1), (month.0, month.1)]) }
}

/// Statements that are not a table but a list of blocks (a bank app's printout): each transaction starts on the line that
/// ends with its amount, with its date, in one piece or as a day with its month below it, and its description around that,
/// over a few lines. The grid gets a header made up here (Date, Description, Amount); every cell below it is text from the
/// PDF. None when it doesn't look like that.
fn read_blocks(
    lines: &[&PdfLine],
    keywords: &[Option<KeywordLine>],
    printed: &str,
    period: &StatementPeriod,
    mut notes: Vec<StatementNote>,
    own_iban: Option<&str>,
) -> Option<StatementRead> {
    static FULL_DATE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\d{1,2}[./-]\d{1,2}[./-]\d{4})"));
    let step = median(steps(lines));
    let mut rank: HashMap<usize, usize> = HashMap::new();
    for (i, l) in lines.iter().enumerate() {
        let r = if i > 0 && lines[i - 1].page == l.page { rank[&lines[i - 1].id] + 1 } else { 0 };
        rank.insert(l.id, r);
    }

    // Without a printed period, the latest full date outside the blocks (the print date) stands for the end of the statement.
    let mut year_period = period.clone();
    if period.from.is_none() && period.to.is_none() {
        let mut dates: Vec<String> = standalone(&FULL_DATE, printed).iter().filter_map(|d| parse_any(d)).collect();
        dates.sort();
        if let Some(latest) = dates.pop() {
            year_period = StatementPeriod { from: None, to: Some(latest) };
        }
    }

    let mut blocks: Vec<Block> = Vec::new();
    let mut current = false;
    let mut dropped = 0;
    for (i, line) in lines.iter().enumerate() {
        let amounts = if keywords[i].is_some() { Vec::new() } else { trailing_amounts(line) };
        if !amounts.is_empty() {
            blocks.push(Block { lines: vec![line], amounts });
            current = true;
            continue;
        }
        // A line below the block belongs to it when it is close; at the top of the next page, when the block has no date yet.
        let joins = current && {
            let block = blocks.last().expect("current block");
            let last = block.lines.last().expect("a block has a line");
            if last.page == line.page {
                last.y - line.y <= step * 1.6
            } else {
                rank[&line.id] < 3 && block_date(block, &year_period).date.is_none()
            }
        };
        if joins {
            blocks.last_mut().expect("current block").lines.push(line);
        } else {
            if !blocks.is_empty() {
                dropped += 1;
            }
            current = false;
        }
    }

    let read: Vec<BlockDate> = blocks.iter().map(|b| block_date(b, &year_period)).collect();
    let dated: Vec<usize> = (0..blocks.len()).filter(|&i| read[i].date.is_some()).collect();
    let amount_counts: HashSet<usize> = dated.iter().map(|&i| blocks[i].amounts.len()).collect();
    let balance = amount_counts.len() == 1 && amount_counts.contains(&2);
    // Without signs the amounts could be money in or out: not worth a guess.
    let signed = dated.iter().any(|&i| {
        let a = &blocks[i].amounts;
        SIGNED.is_match(&a[if balance { a.len() - 2 } else { a.len() - 1 }].text)
    });
    if dated.len() < 2 || dated.len() * 2 < blocks.len() || !signed {
        return None;
    }

    let rows: Vec<Vec<String>> = dated
        .iter()
        .map(|&i| {
            let (block, info) = (&blocks[i], &read[i]);
            let kept = &block.amounts[block.amounts.len() - if balance { 2 } else { 1 }..];
            let start = &block.lines[0].cells;
            let take: usize = kept.iter().map(|a| a.cells).sum();
            let amount_from = start.len() - take;
            let description: Vec<&str> = block
                .lines
                .iter()
                .enumerate()
                .flat_map(|(l, line)| line.cells.iter().enumerate().map(move |(c, cell)| (l, c, cell)))
                .filter(|(l, c, _)| !info.used.contains(&(*l, *c)) && !(*l == 0 && *c >= amount_from))
                .map(|(_, _, cell)| cell.text.as_str())
                .collect();
            let mut row = vec![info.date.clone().expect("dated"), description.join(" ")];
            row.extend(kept.iter().map(|a| a.text.clone()));
            row
        })
        .collect();
    let fields: Vec<Option<&str>> = if balance {
        vec![Some("bookingDate"), Some("description"), Some("amount"), Some("balance")]
    } else {
        vec![Some("bookingDate"), Some("description"), Some("amount")]
    };
    let header: Vec<String> =
        if balance { vec!["Date", "Description", "Amount", "Balance"] } else { vec!["Date", "Description", "Amount"] }
            .into_iter()
            .map(String::from)
            .collect();
    let kept: HashSet<usize> = dated.iter().copied().collect();
    let dropped_lines = dropped + (0..blocks.len()).filter(|i| !kept.contains(i)).map(|i| blocks[i].lines.len()).sum::<usize>();
    if read.iter().any(|b| b.yearless) {
        notes.push(StatementNote::DatesWithoutYear);
    }
    let mut grid = vec![header];
    grid.extend(rows.iter().cloned());
    let result = StatementRead {
        grid: with_ibans(grid, &fields, own_iban),
        header_found: true,
        balances: StatementBalances::default(),
        period: period.clone(),
        notes,
        dropped_lines,
    };
    Some(with_balances(result, keywords, rows.iter().flat_map(|r| r[2..].iter().cloned()).collect()))
}

// ------------------------------------------------------------------------------------- the read

/// `ownIban` is the account's own number; with it, a statement that prints another account's number gets a note.
pub fn read_statement(all_lines: &[PdfLine], own_iban: Option<&str>) -> StatementRead {
    static YEAR: LazyLock<Regex> = LazyLock::new(|| re(r"^((?:19|20)\d{2})"));
    let mut notes: Vec<StatementNote> = Vec::new();
    let margins = margin_lines(all_lines);
    let lines: Vec<&PdfLine> = all_lines.iter().filter(|l| !margins.contains(&l.id)).collect();
    let header_index = lines.iter().position(|l| is_header_line(l));
    let header_found = header_index.is_some();
    // Everything above the table, headers in the margins too.
    let before: Vec<&PdfLine> = match header_index {
        Some(h) => all_lines.iter().filter(|l| l.id < lines[h].id).collect(),
        None => all_lines.iter().collect(),
    };
    let before_text = before.iter().map(|l| cell_texts(l).join(" ")).collect::<Vec<_>>().join(" ");

    // The statement period, from the first line that prints one.
    let mut period = StatementPeriod::default();
    for line in all_lines {
        if let Some(found) = period_of(&lower(&cell_texts(line).join(" "))) {
            period = found;
            break;
        }
    }
    // Without a printed period, the year that is printed above the table stands for the whole statement.
    let mut year_period = period.clone();
    if period.from.is_none() && period.to.is_none() {
        let mut years: Vec<(String, usize)> = Vec::new();
        for y in standalone(&YEAR, &before_text) {
            match years.iter_mut().find(|(k, _)| *k == y) {
                Some((_, n)) => *n += 1,
                None => years.push((y, 1)),
            }
        }
        let mut best: Option<&(String, usize)> = None;
        for y in &years {
            if best.is_none_or(|b| y.1 > b.1) {
                best = Some(y);
            }
        }
        if let Some((year, _)) = best {
            year_period = StatementPeriod { from: None, to: Some(format!("{year}-12-31")) };
        }
    }

    // Another account's statement: the account's own number is not printed above the table, another is.
    if let Some(own_iban) = own_iban.filter(|s| !s.is_empty()) {
        let own = own_iban.chars().filter(|c| !js::is_ws(*c)).collect::<String>().to_uppercase();
        let printed = find_ibans(&before_text);
        if !printed.is_empty() && !printed.contains(&own) {
            notes.push(StatementNote::OtherAccount { iban: mask_iban(&printed[0]) });
        }
    }

    let keywords: Vec<Option<KeywordLine>> = lines.iter().map(|l| keyword_line(l)).collect();
    // A table when there is a header with rows under it, else a list of blocks, else nothing.
    let result = |table: StatementRead, notes: &[StatementNote]| -> StatementRead {
        if !table.grid.is_empty() {
            return table;
        }
        let first_amount =
            lines.iter().enumerate().find(|(i, x)| keywords[*i].is_none() && !trailing_amounts(x).is_empty()).map_or(0, |(_, x)| x.id);
        let printed = all_lines
            .iter()
            .filter(|l| margins.contains(&l.id) || l.id < first_amount)
            .map(|l| cell_texts(l).join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        let other: Vec<StatementNote> = notes.iter().filter(|n| matches!(n, StatementNote::OtherAccount { .. })).cloned().collect();
        read_blocks(&lines, &keywords, &printed, &period, other, own_iban).unwrap_or(table)
    };
    let Some(header_index) = header_index else {
        let read = StatementRead {
            grid: Vec::new(),
            header_found,
            balances: StatementBalances::default(),
            period: period.clone(),
            notes: notes.clone(),
            dropped_lines: 0,
        };
        return result(with_balances(read, &keywords, Vec::new()), &notes);
    };

    let header = lines[header_index];
    let fields: Vec<Option<&str>> = header.cells.iter().map(|c| header_field(&c.text)).collect();
    let find = |name: &str| fields.iter().position(|f| *f == Some(name));
    let date_column = [find("bookingDate"), find("valueDate")].into_iter().flatten().next().unwrap_or(0);
    let step = median(steps(&lines[header_index..]));

    let mut columns: &[PdfCell] = &header.cells;
    let mut header_texts: Vec<String> = header.cells.iter().map(|c| c.text.clone()).collect();
    /// A header label that goes on in the line below it ("Volgnum" / "mer").
    struct AfterHeader {
        y: f64,
        page: usize,
        first: bool,
    }
    let mut after_header: Option<AfterHeader> = None;
    let mut rows: Vec<Vec<String>> = Vec::new();
    struct Current {
        row: usize,
        page: usize,
        y: f64,
    }
    let mut current: Option<Current> = None;
    let mut dropped = 0;
    let mut needs_year = false;

    for (i, line) in lines.iter().enumerate().skip(header_index) {
        if i == header_index || (is_header_line(line) && same_header(line, header)) {
            // The columns may sit elsewhere on this page.
            columns = &line.cells;
            current = None;
            after_header = Some(AfterHeader { y: line.y, page: line.page, first: i == header_index });
            continue;
        }
        if keywords[i].is_some() {
            current = None;
            continue;
        }
        let mut placed: Vec<String> = vec![String::new(); columns.len()];
        for cell in &line.cells {
            let col = column_of(cell, columns);
            if placed[col].is_empty() {
                placed[col] = cell.text.clone();
            } else {
                placed[col] = format!("{} {}", placed[col], cell.text);
            }
        }
        if let Some(date) = date_of(&placed[date_column], &year_period) {
            placed[date_column] = date;
            if let Some(value_column) = find("valueDate").filter(|v| *v != date_column) {
                placed[value_column] = date_of(&placed[value_column], &year_period).unwrap_or_else(|| placed[value_column].clone());
            }
            rows.push(placed);
            current = Some(Current { row: rows.len() - 1, page: line.page, y: line.y });
            after_header = None;
            continue;
        }
        if let Some(a) = after_header.as_mut() {
            if a.page == line.page && (step == 0.0 || a.y - line.y <= step * 1.6) && !line.cells.iter().any(|c| is_amount_text(&c.text)) {
                if a.first {
                    for (col, text) in placed.iter().enumerate() {
                        if !text.is_empty() {
                            header_texts[col] = format!("{} {}", header_texts[col], text);
                        }
                    }
                }
                a.y = line.y;
                continue;
            }
        }
        after_header = None;
        if year_period.from.is_none() && year_period.to.is_none() && yearless(&placed[date_column]).is_some() {
            needs_year = true;
        }
        // A line below a transaction, in the description columns only and close to it, belongs to it.
        let in_structured = placed
            .iter()
            .enumerate()
            .any(|(col, text)| !text.is_empty() && STRUCTURED.contains(&fields.get(col).copied().flatten().unwrap_or("")));
        if let Some(cur) = current.as_mut() {
            if cur.page == line.page && !in_structured && (step == 0.0 || cur.y - line.y <= step * 1.6) {
                for (col, text) in placed.iter().enumerate() {
                    if !text.is_empty() {
                        let row = &mut rows[cur.row][col];
                        *row = if row.is_empty() { text.clone() } else { format!("{row} {text}") };
                    }
                }
                cur.y = line.y;
                continue;
            }
        }
        dropped += 1;
        current = None;
    }
    if needs_year {
        notes.push(StatementNote::DatesWithoutYear);
    }

    let grid = if rows.is_empty() {
        Vec::new()
    } else {
        let mut g = vec![header_texts];
        g.extend(rows.iter().cloned());
        with_ibans(g, &fields, own_iban)
    };
    let read = StatementRead {
        grid,
        header_found,
        balances: StatementBalances::default(),
        period: period.clone(),
        notes: notes.clone(),
        dropped_lines: dropped,
    };
    let amount_columns: Vec<usize> =
        fields.iter().enumerate().filter(|(_, f)| matches!(f, Some("amount" | "debit" | "credit" | "balance"))).map(|(i, _)| i).collect();
    let numbers: Vec<String> = rows.iter().flat_map(|r| amount_columns.iter().map(|&i| r[i].clone()).filter(|t| !t.is_empty())).collect();
    result(with_balances(read, &keywords, numbers), &notes)
}

/// Reads the balance lines with the decimal mark the table's own numbers use.
fn with_balances(read: StatementRead, keywords: &[Option<KeywordLine>], mut numbers: Vec<String>) -> StatementRead {
    let found: Vec<&(Kind, Option<String>)> = keywords.iter().flatten().flat_map(|k| k.found.iter()).collect();
    numbers.extend(found.iter().filter_map(|f| f.1.clone()));
    let decimal = detect_decimal(&numbers);
    let amount = |kind: Kind| -> Option<i64> {
        let values: Vec<Option<i64>> =
            found.iter().filter(|f| f.0 == kind).filter_map(|f| f.1.as_ref()).map(|t| parse_amount(t, Some(decimal))).collect();
        // The first opening balance and the last closing balance are the statement's.
        if kind == Kind::Opening {
            values.iter().copied().flatten().next()
        } else {
            values.iter().rev().copied().flatten().next()
        }
    };
    StatementRead { balances: StatementBalances { opening: amount(Kind::Opening), closing: amount(Kind::Closing) }, ..read }
}

/// An IBAN other than the account's own in a row's text gets a column of its own, unless the table has one.
fn with_ibans(grid: Vec<Vec<String>>, fields: &[Option<&str>], own_iban: Option<&str>) -> Vec<Vec<String>> {
    if fields.contains(&Some("counterpartyIban")) {
        return grid;
    }
    let own: Option<String> = own_iban.map(|s| s.chars().filter(|c| !js::is_ws(*c)).collect::<String>().to_uppercase());
    let found: Vec<String> = grid[1..]
        .iter()
        .map(|row| find_ibans(&row.join(" ")).into_iter().find(|iban| Some(iban) != own.as_ref()).unwrap_or_default())
        .collect();
    if found.iter().all(|f| f.is_empty()) {
        return grid;
    }
    grid.into_iter()
        .enumerate()
        .map(|(i, mut row)| {
            row.push(if i == 0 { "IBAN".to_string() } else { found[i - 1].clone() });
            row
        })
        .collect()
}

// ------------------------------------------------------------------------------- reconciliation

/// The amounts of one row, for the reconciliation; `None` where the grid has none.
#[derive(Clone, Copy, Debug)]
pub struct Amounts {
    pub amount_cents: Option<i64>,
    pub balance_cents: Option<i64>,
}

/// Rows (in file order) whose running balance doesn't follow from the one before; either direction of the file counts.
pub fn running_mismatches(rows: &[Amounts], opening: Option<i64>) -> Vec<bool> {
    let run = |list: &[Amounts]| -> Vec<bool> {
        let mut expected = opening;
        list.iter()
            .map(|r| {
                let Some(amount) = r.amount_cents else { return false };
                if let Some(e) = expected.as_mut() {
                    *e += amount;
                }
                let Some(balance) = r.balance_cents else { return false };
                let wrong = expected.is_some_and(|e| e != balance);
                expected = Some(balance);
                wrong
            })
            .collect()
    };
    let forward = run(rows);
    // Newest first: the same walk from the other end.
    let reversed: Vec<Amounts> = rows.iter().rev().copied().collect();
    let mut backward = run(&reversed);
    backward.reverse();
    let count = |f: &[bool]| f.iter().filter(|b| **b).count();
    if count(&backward) < count(&forward) {
        backward
    } else {
        forward
    }
}

/// Whether the rows add up (`Reconciliation` of src/shared/types.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Reconciliation {
    #[serde(rename = "openingCents")]
    pub opening_cents: Option<i64>,
    #[serde(rename = "closingCents")]
    pub closing_cents: Option<i64>,
    /// Sum of the rows' amounts (rows the person skipped are left out).
    #[serde(rename = "sumCents")]
    pub sum_cents: i64,
    /// Closing minus (opening plus sum); 0 when the rows add up. None when a balance is missing.
    #[serde(rename = "differenceCents")]
    pub difference_cents: Option<i64>,
    #[serde(rename = "rowsChecked")]
    pub rows_checked: usize,
    /// Rows whose running balance doesn't follow from the one before.
    #[serde(rename = "runningMismatches")]
    pub running_mismatches: usize,
}

/// Whether opening balance plus the rows makes the closing balance, and each running balance follows.
pub fn reconcile(rows: &[Amounts], balances: &StatementBalances) -> Reconciliation {
    let counted: Vec<Amounts> = rows.iter().filter(|r| r.amount_cents.is_some()).copied().collect();
    let sum: i64 = counted.iter().filter_map(|r| r.amount_cents).sum();
    let (opening, closing) = (balances.opening, balances.closing);
    Reconciliation {
        opening_cents: opening,
        closing_cents: closing,
        sum_cents: sum,
        difference_cents: opening.zip(closing).map(|(o, c)| c - (o + sum)),
        rows_checked: counted.len(),
        running_mismatches: running_mismatches(&counted, opening).into_iter().filter(|b| *b).count(),
    }
}

/// What to tell about the printed balances against the rows (`ReconciliationBanner` in src/shared/pdf-import.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReconciliationBanner {
    None,
    Ok,
    Mismatch {
        #[serde(rename = "differenceCents")]
        difference_cents: i64,
    },
    /// Does not add up, and the rows move the balance the wrong way round: probably a credit card statement.
    MaybeFlip {
        #[serde(rename = "differenceCents")]
        difference_cents: i64,
    },
}

/// Needs both balances (the difference is None otherwise). The balances imply a movement of closing minus opening; when the
/// rows' sum goes the other way (this includes difference = -2 x sum, the exact mirror image), flipping the signs is suggested.
pub fn reconciliation_banner(r: Option<&Reconciliation>) -> ReconciliationBanner {
    let Some(r) = r else { return ReconciliationBanner::None };
    let Some(difference) = r.difference_cents else { return ReconciliationBanner::None };
    if difference == 0 {
        return ReconciliationBanner::Ok;
    }
    let implied = difference + r.sum_cents;
    let opposite = r.sum_cents != 0 && implied != 0 && r.sum_cents.signum() != implied.signum();
    if opposite {
        ReconciliationBanner::MaybeFlip { difference_cents: difference }
    } else {
        ReconciliationBanner::Mismatch { difference_cents: difference }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn years_and_month_names_equal_the_typescript() {
        let fixtures: Value = serde_json::from_str(include_str!("../tests/fixtures/csvrules.json")).unwrap();
        for c in fixtures["years"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            let period =
                StatementPeriod { from: c["period"]["from"].as_str().map(String::from), to: c["period"]["to"].as_str().map(String::from) };
            assert_eq!(complete_year(input, &period), c["result"].as_str().unwrap(), "completeYear({input:?}, {period:?})");
        }
        for c in fixtures["months"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            assert_eq!(is_month_name(input), c["result"].as_bool().unwrap(), "isMonthName({input:?})");
        }
    }

    #[test]
    fn standalone_numbers_are_not_cut_out_of_longer_ones() {
        let year = re(r"^((?:19|20)\d{2})");
        assert_eq!(standalone(&year, "in 2026 and 12026 and 20267 and 2025."), vec!["2026", "2025"]);
        let full = re(r"^(\d{1,2}[./-]\d{1,2}[./-]\d{4})");
        assert_eq!(standalone(&full, "printed 17.11.2026, 117.11.2026 and 03/11/20261 and 3-1-2026"), vec!["17.11.2026", "3-1-2026"]);
    }

    #[test]
    fn running_balances_are_checked_in_both_directions() {
        let rows = |v: &[(i64, i64)]| -> Vec<Amounts> {
            v.iter().map(|&(a, b)| Amounts { amount_cents: Some(a), balance_cents: Some(b) }).collect()
        };
        // oldest first, all fine
        assert_eq!(running_mismatches(&rows(&[(-100, 900), (-200, 700), (500, 1200)]), Some(1000)), vec![false, false, false]);
        // newest first: the same walk from the other end
        assert_eq!(running_mismatches(&rows(&[(500, 1200), (-200, 700), (-100, 900)]), Some(1000)), vec![false, false, false]);
        // one balance that does not follow
        assert_eq!(running_mismatches(&rows(&[(-100, 900), (-200, 650), (500, 1150)]), Some(1000)), vec![false, true, false]);
    }

    #[test]
    fn the_banner_tells_ok_mismatch_and_flip() {
        let r = |sum, diff| Reconciliation {
            opening_cents: Some(0),
            closing_cents: Some(0),
            sum_cents: sum,
            difference_cents: diff,
            rows_checked: 2,
            running_mismatches: 0,
        };
        assert_eq!(reconciliation_banner(None), ReconciliationBanner::None);
        assert_eq!(reconciliation_banner(Some(&r(100, None))), ReconciliationBanner::None);
        assert_eq!(reconciliation_banner(Some(&r(100, Some(0)))), ReconciliationBanner::Ok);
        // sum +7500 where the balances imply -7500: the exact mirror image
        assert_eq!(reconciliation_banner(Some(&r(7500, Some(-15000)))), ReconciliationBanner::MaybeFlip { difference_cents: -15000 });
        assert_eq!(reconciliation_banner(Some(&r(7500, Some(100)))), ReconciliationBanner::Mismatch { difference_cents: 100 });
        assert_eq!(reconciliation_banner(Some(&r(0, Some(100)))), ReconciliationBanner::Mismatch { difference_cents: 100 });
        let total = reconcile(
            &[Amounts { amount_cents: Some(5000), balance_cents: None }, Amounts { amount_cents: Some(2500), balance_cents: None }],
            &StatementBalances { opening: Some(50000), closing: Some(42500) },
        );
        assert_eq!((total.sum_cents, total.difference_cents, total.rows_checked), (7500, Some(-15000), 2));
    }
}
