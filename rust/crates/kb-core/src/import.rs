//! Import sessions for CSV files and XML (CAMT) statements (src/core/import.ts and the session part of src/core/camt/open.ts).
//! Nothing is written until commit; the person (or the assistant, with confirmation) can change the mapping, skip rows and set
//! categories first. The reading itself (encodings, columns, dates, amounts, CAMT) is in `kb-import`; this module holds the open
//! session, reaches the transactions already in Kasboek, and writes the batch.
//!
//! Not ported yet: PDF statements and the assistant's check (they need `kb-pdf` and `kb-assistant`), so a session never holds
//! a check, notes or PDF data, and `checkApply` and `checkUndo` answer what the TypeScript core answers without one.
use crate::balance::{balance_on, set_bank_balance, BankBalanceResult};
use crate::core::{Actor, Core};
use crate::error::{AppError, AppResult};
use crate::finance::{match_rule, RuleText};
use crate::input::{optional, IntIn, LenVec};
use crate::transfers::{find_transfers_of, pair_transfers, PairRequest};
use kb_db::rows::{ImportedTx, NewTxRow};
use kb_db::{DbError, Store};
use kb_import::camt::open::{plan_xml, xml_mapping, XmlNote, XmlSessionData};
use kb_import::camt::read::read_camt_default;
use kb_import::csv::mapping::{auto_map, detect_layout, header_signature, Columns, DateOrder, Mapping};
use kb_import::csv::normalize::normalize_rows;
use kb_import::csv::read::{decode, detect_delimiter, parse_csv};
use kb_import::fingerprint::fingerprint;
use kb_import::group::group_key;
use kb_import::rows::{build_rows, file_balance, Built, Existing, ImportRow, Learned, Ledger, RowOverride, RuleView};
use kb_import::statement::{reconcile, Amounts, Reconciliation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_ROWS: usize = 50_000;

/// The open imports, in the order they were opened (the last one is "the" import of `import.current`).
#[derive(Default)]
pub struct ImportState {
    sessions: Vec<Session>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Csv,
    Xml,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Xml => "xml",
        }
    }
}

struct Session {
    id: String,
    file_name: String,
    account_id: i64,
    kind: Kind,
    xml: Option<XmlSessionData>,
    encoding: &'static str,
    rows: Vec<Vec<String>>,
    mapping: Option<Mapping>,
    mapping_source: &'static str,
    layout: Option<&'static str>,
    /// The header row found when the file was opened. Above it are the lines of the bank and the holder (name, address, account
    /// number); the assistant never gets rows at or above it, and cannot move the header up past it.
    header_floor: usize,
    overrides: HashMap<usize, RowOverride>,
    /// Readable names learned from earlier imports, by the bank's own text (read once per import).
    learned: Option<HashMap<String, Learned>>,
}

impl Session {
    /// How many data rows (counted from the one after the mapping's header row) lie at or above the header row found on opening.
    fn hidden_rows(&self) -> usize {
        self.header_floor.saturating_sub(self.mapping.as_ref().map_or(0, |m| m.header_row))
    }
}

impl ImportState {
    fn find(&mut self, id: &str) -> AppResult<&mut Session> {
        self.sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| AppError::new("import.expired", "This import is no longer open. Choose the file again."))
    }
}

/// The id of the import that was opened last.
pub fn latest_session<S: Store>(core: &Core<S>) -> Option<String> {
    core.import.borrow().sessions.last().map(|s| s.id.clone())
}

/// A random version 4 UUID (`randomUUID`), from the injected generator.
fn new_id<S: Store>(core: &Core<S>) -> String {
    let (a, b) = (core.rng.next_u64(), core.rng.next_u64());
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&a.to_be_bytes());
    bytes[8..].copy_from_slice(&b.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn require_account<S: Store>(store: &S, account_id: i64) -> AppResult<kb_db::rows::AccountRow> {
    store.account_get(account_id)?.ok_or_else(|| AppError::new("accounts.not_found", "Choose an account first."))
}

/* ---------- The mapping as an input ---------- */

type Col = IntIn<0, 9_007_199_254_740_991>;

#[derive(Deserialize)]
enum DelimiterIn {
    #[serde(rename = ";")]
    Semicolon,
    #[serde(rename = ",")]
    Comma,
    #[serde(rename = "\t")]
    Tab,
    #[serde(rename = "|")]
    Pipe,
}

#[derive(Deserialize)]
enum DateOrderIn {
    #[serde(rename = "DMY")]
    Dmy,
    #[serde(rename = "YMD")]
    Ymd,
    #[serde(rename = "MDY")]
    Mdy,
}

#[derive(Deserialize)]
enum DecimalIn {
    #[serde(rename = ",")]
    Comma,
    #[serde(rename = ".")]
    Dot,
}

fn no_columns() -> LenVec<Col, 0, 6> {
    LenVec(Vec::new())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ColumnsIn {
    booking_date: Col,
    #[serde(default, deserialize_with = "optional")]
    value_date: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    amount: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    debit: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    credit: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    direction: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    currency: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    counterparty_name: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    counterparty_iban: Option<Col>,
    #[serde(default = "no_columns")]
    description: LenVec<Col, 0, 6>,
    #[serde(default, deserialize_with = "optional")]
    communication: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    bank_reference: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    status: Option<Col>,
    #[serde(default, deserialize_with = "optional")]
    balance: Option<Col>,
}

/// `mappingSchema` of src/shared/import-mapping.ts: which CSV column means what.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MappingIn {
    delimiter: DelimiterIn,
    header_row: Col,
    date_order: DateOrderIn,
    decimal: DecimalIn,
    #[serde(default)]
    invert_sign: bool,
    columns: ColumnsIn,
}

impl MappingIn {
    /// The mapping, or the schema's refusal when no amount column is given.
    pub fn into_mapping(self) -> AppResult<Mapping> {
        let c = self.columns;
        if c.amount.is_none() && c.debit.is_none() && c.credit.is_none() {
            return Err(AppError::invalid_input("An amount column is needed."));
        }
        let col = |c: Option<Col>| c.map(|c| c.0 as usize);
        Ok(Mapping {
            delimiter: match self.delimiter {
                DelimiterIn::Semicolon => ';',
                DelimiterIn::Comma => ',',
                DelimiterIn::Tab => '\t',
                DelimiterIn::Pipe => '|',
            },
            header_row: self.header_row.0 as usize,
            date_order: match self.date_order {
                DateOrderIn::Dmy => DateOrder::Dmy,
                DateOrderIn::Ymd => DateOrder::Ymd,
                DateOrderIn::Mdy => DateOrder::Mdy,
            },
            decimal: match self.decimal {
                DecimalIn::Comma => ',',
                DecimalIn::Dot => '.',
            },
            invert_sign: self.invert_sign,
            columns: Columns {
                booking_date: c.booking_date.0 as usize,
                value_date: col(c.value_date),
                amount: col(c.amount),
                debit: col(c.debit),
                credit: col(c.credit),
                direction: col(c.direction),
                currency: col(c.currency),
                counterparty_name: col(c.counterparty_name),
                counterparty_iban: col(c.counterparty_iban),
                description: c.description.0.iter().map(|c| c.0 as usize).collect(),
                communication: col(c.communication),
                bank_reference: col(c.bank_reference),
                status: col(c.status),
                balance: col(c.balance),
            },
        })
    }
}

/// `mappingSchema.safeParse(value)`: the mapping, or `None` when the value is not a valid one.
fn parse_mapping(value: Value) -> Option<Mapping> {
    serde_json::from_value::<MappingIn>(value).ok()?.into_mapping().ok()
}

/// The mapping detected from the header names, unless one saved from an earlier import with the same header row exists.
fn detect_mapping<S: Store>(store: &S, rows: &[Vec<String>], delimiter: char) -> AppResult<(Option<Mapping>, &'static str)> {
    let mut mapping = auto_map(rows, delimiter)?;
    let mut source = if mapping.is_some() { "detected" } else { "none" };
    let signature_kind = delimiter.to_string();
    for row in rows.iter().take(15) {
        if let Some(saved) = store.csv_profile_get(&header_signature(row, &signature_kind))? {
            // `JSON.parse` throws on damaged text; a mapping that fails the schema is left unused.
            let value: Value = serde_json::from_str(&saved).map_err(|_| AppError::failed())?;
            if let Some(m) = parse_mapping(value) {
                mapping = Some(m);
                source = "saved";
            }
            break;
        }
    }
    Ok((mapping, source))
}

/* ---------- Opening ---------- */

struct Opening {
    file_name: String,
    account_id: i64,
    encoding: &'static str,
    rows: Vec<Vec<String>>,
    kind: Kind,
    delimiter: char,
    xml: Option<XmlSessionData>,
    mapping: Option<Mapping>,
}

/// Opens the session for rows of text, however they were read: one open session per account.
fn open_session<S: Store>(core: &Core<S>, input: Opening) -> AppResult<ImportPreview> {
    let store = core.db()?;
    if input.rows.len() > MAX_ROWS {
        return Err(AppError::new("import.too_many", "This file has more than 50,000 rows."));
    }
    // An XML statement has fixed fields: its columns are known, not detected.
    let (mapping, source) = match input.mapping {
        Some(m) => (Some(m), "detected"),
        None => detect_mapping(store, &input.rows, input.delimiter)?,
    };
    let header_row = mapping.as_ref().map_or(0, |m| m.header_row);
    let mut session = Session {
        id: new_id(core),
        file_name: input.file_name,
        account_id: input.account_id,
        kind: input.kind,
        xml: input.xml,
        encoding: input.encoding,
        layout: detect_layout(input.rows.get(header_row).map_or(&[][..], Vec::as_slice)),
        rows: input.rows,
        mapping,
        mapping_source: source,
        header_floor: header_row,
        overrides: HashMap::new(),
        learned: None,
    };
    let mut state = core.import.borrow_mut();
    state.sessions.retain(|s| s.account_id != input.account_id);
    let preview = preview_session(store, &mut session);
    state.sessions.push(session);
    preview
}

pub fn analyze<S: Store>(core: &Core<S>, file_name: &str, account_id: i64, bytes: &[u8]) -> AppResult<ImportPreview> {
    if bytes.len() > MAX_BYTES {
        return Err(AppError::new("import.too_big", "This file is larger than 10 MB."));
    }
    require_account(core.db()?, account_id)?;
    if bytes.starts_with(b"%PDF-") {
        return Err(AppError::new("import.is_pdf", "This is a PDF file. Open it as a bank statement instead."));
    }
    let (text, encoding) = decode(bytes);
    let delimiter = detect_delimiter(&text);
    let rows = parse_csv(&text, delimiter);
    if rows.len() < 2 {
        return Err(AppError::new("import.empty", "This file has no rows to import."));
    }
    open_session(
        core,
        Opening { file_name: file_name.to_owned(), account_id, encoding, rows, kind: Kind::Csv, delimiter, xml: None, mapping: None },
    )
}

/// Opens an import session from an XML (CAMT) statement.
pub fn analyze_xml<S: Store>(core: &Core<S>, file_name: &str, account_id: i64, bytes: &[u8]) -> AppResult<ImportPreview> {
    let account = require_account(core.db()?, account_id)?;
    let statements = read_camt_default(bytes)?;
    let (grid, xml) = plan_xml(statements, account.iban.as_deref(), &account.currency)?;
    if grid.len() < 2 {
        return Err(AppError::new("import.empty", "This file has no rows to import."));
    }
    open_session(
        core,
        Opening {
            file_name: file_name.to_owned(),
            account_id,
            encoding: "xml",
            rows: grid,
            kind: Kind::Xml,
            delimiter: ',',
            xml: Some(xml),
            mapping: Some(xml_mapping()),
        },
    )
}

/* ---------- Rows ---------- */

struct StoreLedger<'a, S: Store>(&'a S);

fn existing(rows: Vec<ImportedTx>) -> Vec<Existing> {
    rows.into_iter()
        .map(|r| Existing {
            id: r.id,
            booking_date: r.booking_date,
            counterparty_name: r.counterparty_name,
            description: r.description,
            bank_counterparty: r.bank_counterparty,
            bank_description: r.bank_description,
            bank_reference: r.bank_reference,
            fingerprint: r.fingerprint,
        })
        .collect()
}

impl<S: Store> Ledger for StoreLedger<'_, S> {
    type Error = AppError;

    fn by_fingerprint(&self, account_id: i64, fingerprint: &str) -> AppResult<Vec<Existing>> {
        Ok(existing(self.0.import_by_fingerprint(account_id, fingerprint)?))
    }

    fn by_reference(&self, account_id: i64, reference: &str) -> AppResult<Vec<Existing>> {
        Ok(existing(self.0.import_by_reference(account_id, reference)?))
    }

    fn nearby(&self, account_id: i64, amount_cents: i64, from: &str, to: &str) -> AppResult<Vec<Existing>> {
        Ok(existing(self.0.import_nearby(account_id, amount_cents, from, to)?))
    }
}

/// Names and descriptions tidied in earlier imports, keyed by the bank's own text: a new row with the same bank text gets the
/// same readable text, so rules made on readable names keep working.
fn learned_names<S: Store>(store: &S) -> AppResult<HashMap<String, Learned>> {
    let mut map = HashMap::new();
    // The latest one wins, so a name corrected later is the one used.
    for r in store.import_tidied()? {
        let key = group_key(
            r.bank_counterparty.as_deref(),
            &r.bank_description,
            Some(r.amount_cents),
            r.communication.as_deref(),
            r.counterparty_iban.as_deref(),
        );
        map.insert(key, Learned { name: r.counterparty_name, description: r.description });
    }
    Ok(map)
}

fn build<S: Store>(store: &S, s: &mut Session) -> AppResult<Vec<Built>> {
    let Some(mapping) = &s.mapping else { return Ok(Vec::new()) };
    let account = store.account_get(s.account_id)?.ok_or_else(AppError::failed)?;
    let clean = normalize_rows(&s.rows, mapping, &account.currency);
    let rules = store.rules_all()?;
    if s.learned.is_none() {
        s.learned = Some(learned_names(store)?);
    }
    let learned = s.learned.as_ref().expect("learned names were just read");
    let rule = |v: &RuleView<'_>| {
        match_rule(
            &rules,
            &RuleText {
                counterparty_name: v.counterparty_name,
                description: Some(v.description),
                counterparty_iban: v.counterparty_iban,
                ..RuleText::default()
            },
        )
        .map(|r| r.category_id)
    };
    build_rows(&StoreLedger(store), s.account_id, clean, &s.overrides, learned, &rule)
}

/* ---------- The preview ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    total: usize,
    ready: usize,
    duplicates: usize,
    possible_duplicates: usize,
    problems: usize,
    skipped: usize,
    in_cents: f64,
    out_cents: f64,
    from: Option<String>,
    to: Option<String>,
    file_from: Option<String>,
    file_to: Option<String>,
}

#[derive(Serialize)]
struct XmlPart {
    reconciliation: Reconciliation,
    notes: Vec<XmlNote>,
}

/// `ImportPreview` of src/shared/types.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    session_id: String,
    file_name: String,
    account_id: i64,
    account_name: String,
    currency: String,
    layout: Option<&'static str>,
    encoding: &'static str,
    mapping_source: &'static str,
    headers: Vec<String>,
    sample: Vec<Vec<String>>,
    mapping: Option<Mapping>,
    rows: Vec<ImportRow>,
    stats: Stats,
    notes: Vec<String>,
    edited: usize,
    check: Option<Value>,
    file_kind: &'static str,
    pdf: Option<Value>,
    xml: Option<XmlPart>,
    #[serde(skip)]
    hidden_rows: usize,
}

impl ImportPreview {
    /// The preview as the assistant may see it: nothing from above the header row found on opening, and no header names then.
    pub fn assistant_view(mut self) -> Self {
        if self.hidden_rows > 0 {
            let hidden = self.hidden_rows;
            self.headers.clear();
            self.sample.clear();
            self.rows.retain(|r| r.index >= hidden);
        }
        self
    }
}

/// The statement's printed balances against the rows (rows the person skipped are left out).
fn reconciliation(xml: &XmlSessionData, built: &[Built]) -> Reconciliation {
    let rows: Vec<Amounts> = built
        .iter()
        .filter(|b| b.row.status != "skipped")
        .map(|b| Amounts { amount_cents: b.clean.amount_cents, balance_cents: b.raw.balance_cents })
        .collect();
    reconcile(&rows, xml.balances)
}

/// `Array.prototype.sort()` of dates, where a missing date sorts as the text "null".
fn sorted(mut dates: Vec<Option<&str>>) -> Vec<Option<&str>> {
    dates.sort_by(|a, b| a.unwrap_or("null").cmp(b.unwrap_or("null")));
    dates
}

fn preview_session<S: Store>(store: &S, s: &mut Session) -> AppResult<ImportPreview> {
    let built = build(store, s)?;
    let ready: Vec<&ImportRow> = built.iter().map(|b| &b.row).filter(|r| r.status == "ready").collect();
    let dates = sorted(ready.iter().map(|r| r.booking_date.as_deref()).collect());
    let file_dates: Vec<&str> =
        sorted(built.iter().map(|b| b.row.booking_date.as_deref().filter(|d| !d.is_empty())).filter(Option::is_some).collect())
            .into_iter()
            .flatten()
            .collect();
    let header_row = s.mapping.as_ref().map_or(0, |m| m.header_row);
    let account = store.account_get(s.account_id)?.ok_or_else(AppError::failed)?;
    let count = |status: &str| built.iter().filter(|b| b.row.status == status).count();
    let stats = Stats {
        total: built.len(),
        ready: ready.len(),
        duplicates: count("duplicate"),
        possible_duplicates: count("possible_duplicate"),
        problems: count("problem"),
        skipped: count("skipped"),
        in_cents: ready.iter().fold(0.0, |t, r| t + (r.amount_cents.unwrap_or(0) as f64).max(0.0)),
        out_cents: ready.iter().fold(0.0, |t, r| t - (r.amount_cents.unwrap_or(0) as f64).min(0.0)),
        from: dates.first().copied().flatten().map(str::to_owned),
        to: dates.last().copied().flatten().map(str::to_owned),
        file_from: file_dates.first().map(|d| (*d).to_owned()),
        file_to: file_dates.last().map(|d| (*d).to_owned()),
    };
    let xml = s.xml.as_ref().map(|x| XmlPart { reconciliation: reconciliation(x, &built), notes: x.notes.clone() });
    Ok(ImportPreview {
        session_id: s.id.clone(),
        file_name: s.file_name.clone(),
        account_id: s.account_id,
        account_name: account.name,
        currency: account.currency,
        layout: s.layout,
        encoding: s.encoding,
        mapping_source: s.mapping_source,
        headers: s.rows.get(header_row).cloned().unwrap_or_default(),
        sample: s.rows.iter().skip(header_row + 1).take(5).cloned().collect(),
        mapping: s.mapping.clone(),
        rows: built.into_iter().map(|b| b.row).collect(),
        stats,
        notes: Vec::new(),
        edited: s.overrides.len(),
        check: None,
        file_kind: s.kind.as_str(),
        pdf: None,
        xml,
        hidden_rows: s.hidden_rows(),
    })
}

pub fn preview<S: Store>(core: &Core<S>, id: &str) -> AppResult<ImportPreview> {
    let mut state = core.import.borrow_mut();
    let s = state.find(id)?;
    preview_session(core.db()?, s)
}

/* ---------- Changing the open import ---------- */

pub fn remap<S: Store>(core: &Core<S>, id: &str, mut mapping: Mapping, source: &'static str) -> AppResult<ImportPreview> {
    let mut state = core.import.borrow_mut();
    let s = state.find(id)?;
    // An XML statement states its signs (credit/debit) itself: they are never flipped.
    if s.kind == Kind::Xml {
        mapping.invert_sign = false;
    }
    let width = s.rows.iter().map(Vec::len).max().unwrap_or(0);
    if mapping.columns.used().any(|c| c >= width) || mapping.header_row + 1 >= s.rows.len() {
        return Err(AppError::new("import.bad_mapping", "That column doesn’t exist in this file."));
    }
    if source == "assistant" && mapping.header_row < s.header_floor {
        return Err(AppError::new(
            "import.header_above",
            format!(
                "The header row can’t be moved above row {0}: the lines above the table hold personal details and are not available to you. Keep headerRow at {0} or higher.",
                s.header_floor
            ),
        ));
    }
    s.layout = detect_layout(s.rows.get(mapping.header_row).map_or(&[][..], Vec::as_slice)).or(s.layout);
    s.mapping = Some(mapping);
    s.mapping_source = source;
    preview_session(core.db()?, s)
}

/// A change to one row, as `import.updateRows` gives it.
pub struct RowChange {
    pub index: usize,
    pub change: RowOverride,
}

pub fn update_rows<S: Store>(core: &Core<S>, id: &str, changes: Vec<RowChange>) -> AppResult<ImportPreview> {
    let mut state = core.import.borrow_mut();
    let s = state.find(id)?;
    for RowChange { index, mut change } in changes {
        // A category chosen without saying who chose it is the person's.
        if change.category_id.is_some() && change.category_source.is_none() {
            change.category_source = Some(kb_import::rows::CategorySource::User);
        }
        s.overrides.entry(index).or_default().merge(change);
    }
    preview_session(core.db()?, s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRow {
    index: usize,
    cells: Vec<String>,
}

/// Raw rows for the assistant: header plus a window of data rows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawWindow {
    header_row: usize,
    header: Vec<String>,
    rows: Vec<RawRow>,
    total_rows: usize,
    /// The lines above the header (the person's own view; the assistant gets only how many there are).
    #[serde(skip_serializing_if = "Option::is_none")]
    preamble: Option<Vec<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preamble_lines: Option<usize>,
}

pub fn raw_window<S: Store>(core: &Core<S>, id: &str, from: usize, count: usize, actor: Actor) -> AppResult<RawWindow> {
    let mut state = core.import.borrow_mut();
    let s = state.find(id)?;
    let hr = s.mapping.as_ref().map_or(0, |m| m.header_row);
    let data = s.rows.get(hr + 1..).unwrap_or_default();
    let window = |start: usize| -> Vec<RawRow> {
        data.iter()
            .enumerate()
            .skip(start)
            .take((from + count).saturating_sub(start))
            .map(|(index, cells)| RawRow { index, cells: cells.clone() })
            .collect()
    };
    if actor == Actor::Assistant {
        // Rows at or above the header found on opening are never returned, nor their count (it is the person's own choice of
        // header row that can put them there, never the assistant's).
        let hidden = s.hidden_rows();
        return Ok(RawWindow {
            header_row: hr,
            header: if hidden > 0 { Vec::new() } else { s.rows.get(hr).cloned().unwrap_or_default() },
            rows: window(from.max(hidden)),
            total_rows: data.len(),
            preamble: None,
            preamble_lines: Some(hr),
        });
    }
    Ok(RawWindow {
        header_row: hr,
        header: s.rows.get(hr).cloned().unwrap_or_default(),
        rows: window(from),
        total_rows: data.len(),
        preamble: Some(s.rows.iter().take(hr).cloned().collect()),
        preamble_lines: None,
    })
}

/// `import.checkApply`: the check of the assistant is not ported, so no open import has one to apply.
pub fn apply_check<S: Store>(core: &Core<S>, id: &str) -> AppResult<Value> {
    core.import.borrow_mut().find(id)?;
    Err(AppError::new("import.no_check", "There is nothing to apply: check the file first."))
}

/// `import.checkUndo`: without a check there is nothing to undo.
pub fn undo_check<S: Store>(core: &Core<S>, id: &str) -> AppResult<ImportPreview> {
    preview(core, id)
}

pub fn discard<S: Store>(core: &Core<S>, id: &str) {
    core.import.borrow_mut().sessions.retain(|s| s.id != id);
}

/* ---------- Commit ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    batch_id: i64,
    imported: usize,
    skipped: usize,
    last_date: Option<String>,
    balance_on_last_date: Option<f64>,
    bank_balance: Option<BankBalanceResult>,
    balance_note: Option<String>,
    transfers_paired: u64,
    transfers_suggested: usize,
    ask_balance: bool,
}

/// The bank's balance at the end of the file: from a balance column, else the closing balance of an XML statement, dated at the
/// end of its period (only a real closing balance on the date the file gives for it; no fallbacks).
fn bank_closing(s: &Session, built: &[Built]) -> Option<(String, i64)> {
    let rows: Vec<(Option<&str>, Option<i64>)> = built.iter().map(|b| (b.raw.booking_date.as_deref(), b.raw.balance_cents)).collect();
    if let Some(found) = file_balance(&rows) {
        return Some(found);
    }
    let xml = s.xml.as_ref()?;
    match (xml.closing_is_final, xml.balances.closing, &xml.period.to) {
        (true, Some(closing), Some(to)) => Some((to.clone(), closing)),
        _ => None,
    }
}

pub fn commit<S: Store>(core: &Core<S>, id: &str, save_profile: bool) -> AppResult<CommitResult> {
    let store = core.db()?;
    let (mapping, built, account_id, file_name, layout, kind, header) = {
        let mut state = core.import.borrow_mut();
        let s = state.find(id)?;
        let mapping =
            s.mapping.clone().ok_or_else(|| AppError::new("import.no_mapping", "Choose which columns hold the date and amount first."))?;
        let built = build(store, s)?;
        let header = s.rows.get(mapping.header_row).cloned().unwrap_or_default();
        (mapping, built, s.account_id, s.file_name.clone(), s.layout, s.kind, header)
    };
    let ready: Vec<&Built> = built.iter().filter(|b| b.row.status == "ready").collect();
    if ready.is_empty() {
        return Err(AppError::new("import.nothing", "There are no rows ready to import."));
    }
    let account = store.account_get(account_id)?.ok_or_else(AppError::failed)?;
    let rules = store.rules_all()?;
    let batch_id = store.transaction::<_, AppError, _>(|db| {
        let batch_id = db.batch_insert(account_id, &file_name, layout, ready.len() as i64)?;
        for b in &ready {
            let (row, clean, raw) = (&b.row, &b.clean, &b.raw);
            // A row the person included against the file's own refusal can lack a date or amount: the database refuses it.
            let (Some(booking_date), Some(amount_cents)) = (row.booking_date.clone(), row.amount_cents) else {
                return Err(AppError::failed());
            };
            let description = if row.description.is_empty() { "(no description)".to_owned() } else { row.description.clone() };
            let bank_description = [raw.description.as_str(), row.description.as_str()]
                .into_iter()
                .find(|d| !d.is_empty())
                .unwrap_or("(no description)")
                .to_owned();
            let category_id = row.category_id.or_else(|| {
                match_rule(
                    &rules,
                    &RuleText {
                        counterparty_name: row.counterparty_name.as_deref(),
                        description: Some(&description),
                        bank_counterparty: raw.counterparty_name.as_deref(),
                        bank_description: Some(&bank_description),
                        counterparty_iban: row.counterparty_iban.as_deref(),
                    },
                )
                .map(|r| r.category_id)
            });
            let currency = match clean.currency.as_deref() {
                Some(c) if c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()) => c.to_owned(),
                _ => account.currency.clone(),
            };
            let fp = b.fingerprint.clone().unwrap_or_else(|| {
                fingerprint(
                    account_id,
                    &booking_date,
                    amount_cents,
                    row.counterparty_name.as_deref(),
                    Some(&description),
                    clean.bank_reference.as_deref(),
                )
            });
            db.tx_insert(&NewTxRow {
                account_id,
                booking_date,
                value_date: clean.value_date.clone(),
                amount_cents,
                currency,
                description,
                counterparty_name: row.counterparty_name.clone(),
                counterparty_iban: row.counterparty_iban.clone(),
                communication: row.communication.clone(),
                category_id,
                notes: None,
                import_batch_id: Some(batch_id),
                bank_reference: clean.bank_reference.clone(),
                fingerprint: fp,
                bank_counterparty: raw.counterparty_name.clone(),
                bank_description,
            })?;
        }
        // An XML statement has fixed columns: there is no layout to remember.
        if save_profile && kind != Kind::Xml {
            let json = serde_json::to_string(&mapping).map_err(|_| AppError::failed())?;
            db.csv_profile_save(layout.unwrap_or(&file_name), layout, &header_signature(&header, &mapping.delimiter.to_string()), &json)?;
        }
        Ok(batch_id)
    })?;
    let session = {
        let mut state = core.import.borrow_mut();
        let at = state.sessions.iter().position(|s| s.id == id);
        at.map(|i| state.sessions.remove(i))
    };

    // Transfers to or from another own account that are sure (the account number matches) are paired at once; others are only
    // suggested.
    let ids = store.batch_tx_ids(batch_id)?;
    let found = if ids.is_empty() { Vec::new() } else { find_transfers_of(store, Some(&ids))? };
    let sure: Vec<PairRequest> = found
        .iter()
        .filter(|f| f.confidence == "iban")
        .map(|f| PairRequest { out_id: f.out_id, in_id: f.in_id, cost_cents: f.cost_cents })
        .collect();
    let transfers_paired = pair_transfers(core, &sure)?;
    let transfers_suggested = found.iter().filter(|f| f.confidence == "amount").count();
    let dates = sorted(built.iter().map(|b| b.row.booking_date.as_deref().filter(|d| !d.is_empty())).filter(Option::is_some).collect());
    let last_date = dates.last().copied().flatten().map(str::to_owned);
    // A balance column: the balance after the last transaction of the file is what the bank showed that day, so it is recorded
    // (and compared with what Kasboek expected).
    let mut bank_balance = None;
    let mut balance_note = None;
    let from_file = session.as_ref().and_then(|s| bank_closing(s, &built));
    if let (Some((date, cents)), true) = (from_file, account.kind != "investment") {
        let note = if kind == Kind::Xml { "From the XML" } else { "From the CSV" };
        match set_bank_balance(store, account_id, &date, cents, Some(note), &core.today()) {
            Ok(result) => bank_balance = Some(result),
            Err(e) => balance_note = Some(e.message),
        }
    }
    let has_balance = !store.valuations_list(account_id)?.is_empty();
    Ok(CommitResult {
        batch_id,
        imported: ready.len(),
        skipped: built.len() - ready.len(),
        balance_on_last_date: match &last_date {
            Some(d) => Some(balance_on(store, account_id, d, None)?),
            None => None,
        },
        last_date,
        bank_balance,
        balance_note,
        transfers_paired,
        transfers_suggested,
        ask_balance: account.kind != "investment" && !has_balance,
    })
}

/* ---------- Batches ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    id: i64,
    file_name: String,
    account_name: String,
    row_count: i64,
    committed_at: String,
    remaining: i64,
}

pub fn list_batches<S: Store>(store: &S) -> AppResult<Vec<Batch>> {
    Ok(store
        .batch_list()?
        .into_iter()
        .map(|b| Batch {
            id: b.id,
            file_name: b.file_name,
            account_name: b.account_name,
            row_count: b.row_count,
            committed_at: b.committed_at,
            remaining: b.remaining,
        })
        .collect())
}

pub fn undo_batch<S: Store>(store: &S, batch_id: i64) -> AppResult<u64> {
    Ok(store.transaction::<_, DbError, _>(|db| db.batch_undo(batch_id))?)
}
