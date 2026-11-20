//! Reads an ISO 20022 bank statement (CAMT.053; CAMT.052 and CAMT.054 lists of entries too) into rows
//! (src/core/camt/read.ts). Names are matched without namespace, so every version (.001.02, .001.08, ...) reads the same way.
//! Amounts are exact (text to cents, never a float) and the sign comes from the credit/debit indicator, never from a guess.
//! Nothing is read from the network or run.
use super::xml::{parse_xml, path, text_at, Node, XmlFailure};
use crate::error::ImportError;
use crate::jsstr::{is_js_space, js_trim};
use regex::Regex;
use std::sync::LazyLock;

pub const MAX_XML_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
/// More statements than this in one file is not a statement file anyone downloads.
const MAX_STATEMENTS: usize = 1_000;
/// Versions of camt.052/053/054 whose entries are read (.001.01 to .001.14).
const MAX_VERSION: u32 = 14;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CamtRow {
    pub booking_date: String,
    pub value_date: String,
    /// Signed cents as text with a decimal point ("-12.50"); empty when the file's amount or indicator is unusable.
    pub amount: String,
    pub currency: String,
    pub counterparty: String,
    pub counterparty_iban: String,
    pub description: String,
    pub communication: String,
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CamtStatement {
    /// The account's IBAN, else its other identification, else "".
    pub account: String,
    pub is_iban: bool,
    /// The statement's currency (account, else opening balance), "" when the file does not say.
    pub currency: String,
    pub opening: Option<i64>,
    /// The closing booked balance (CLBD), else the intraday one (ITBD); never the available balance (CLAV).
    pub closing: Option<i64>,
    /// Whether closing is the real closing balance (CLBD), so it may be recorded as the bank's balance.
    pub closing_is_final: bool,
    pub from: Option<String>,
    pub to: Option<String>,
    pub rows: Vec<CamtRow>,
    /// Entries that are not booked (pending, or for information only).
    pub not_booked: usize,
}

fn too_large() -> ImportError {
    ImportError::new("import.xml_too_large", "This file is larger than 20 MB or has more than 50,000 rows.")
}

fn broken() -> ImportError {
    ImportError::new("import.xml_broken", "This XML file could not be read. The file may be damaged. Download it again from your bank.")
}

static DECLARED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"^[{s}]*<\?xml[^>]*[{s}]encoding[{s}]*=[{s}]*["']([A-Za-z0-9._-]+)["']"#, s = crate::jsstr::JS_SPACE))
        .expect("declaration regex")
});

/// Text to bytes to text: UTF-8 (also with a BOM), UTF-16 with a BOM, or the encoding the XML declaration names.
pub fn decode_xml(bytes: &[u8]) -> Result<String, ImportError> {
    let encoding = match bytes {
        [0xff, 0xfe, ..] | [0x3c, 0x00, ..] => encoding_rs::UTF_16LE,
        [0xfe, 0xff, ..] | [0x00, 0x3c, ..] => encoding_rs::UTF_16BE,
        _ => {
            let head = encoding_rs::WINDOWS_1252.decode_without_bom_handling(&bytes[..bytes.len().min(200)]).0;
            match DECLARED.captures(&head) {
                None => encoding_rs::UTF_8,
                Some(m) => {
                    // `new TextDecoder(label)` refuses an unknown label, the "replacement" ones, and x-user-defined (ICU has no table).
                    let label = m[1].to_lowercase();
                    match encoding_rs::Encoding::for_label(label.as_bytes()) {
                        Some(e) if e != encoding_rs::REPLACEMENT && e != encoding_rs::X_USER_DEFINED => e,
                        _ => return Err(broken()),
                    }
                }
            }
        }
    };
    Ok(encoding.decode_with_bom_removal(bytes).0.into_owned())
}

/// Decimal text as cents, rounding half up. Takes the forms of xs:decimal ("1234.5", ".5", "1.", "+1.00", "0.075"); `None`
/// for anything else (also negative text, thousands separators and huge values).
pub fn cents_of(text: &str) -> Option<i64> {
    let t = js_trim(text);
    let t = t.strip_prefix('+').unwrap_or(t);
    let (whole, frac) = match t.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (t, None),
    };
    let digits = |s: &str, max: usize| s.len() <= max && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole, 15) || frac.is_some_and(|f| !digits(f, 10)) || (whole.is_empty() && frac.is_none_or(str::is_empty)) {
        return None;
    }
    let frac3 = format!("{:0<3}", frac.unwrap_or(""));
    let b = frac3.as_bytes();
    let whole_value: f64 = if whole.is_empty() { 0.0 } else { whole.parse().ok()? };
    let cents = whole_value * 100.0 + f64::from((b[0] - b'0') * 10 + (b[1] - b'0')) + if b[2] >= b'5' { 1.0 } else { 0.0 };
    (cents.is_finite() && cents.fract() == 0.0 && cents.abs() <= 9_007_199_254_740_991.0).then_some(cents as i64)
}

fn format_cents(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    format!("{}{}.{:02}", if cents < 0 { "-" } else { "" }, abs / 100, abs % 100)
}

/// The date part of "2026-03-04" or "2026-03-04T10:00:00+01:00"; the clock and zone are not used. A date-time is taken as
/// the date the bank wrote, with no conversion to the local time zone, so the day matches the bank's own statement.
fn iso_day(text: &str) -> &str {
    let b = text.as_bytes();
    let ok = b.len() >= 10 && b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if ok {
        &text[..10]
    } else {
        ""
    }
}

/// The date of a Dt/DtTm choice element (BookgDt, ValDt, a balance's Dt); Dt is preferred over DtTm.
fn date_of(n: Option<Node<'_>>) -> String {
    let dt = text_at(n, &["Dt"]);
    iso_day(if dt.is_empty() { text_at(n, &["DtTm"]) } else { dt }).to_owned()
}

/// A balance's amount with its sign, or `None`.
fn balance_cents(bal: Node<'_>) -> Option<i64> {
    let cents = cents_of(text_at(Some(bal), &["Amt"]))?;
    match text_at(Some(bal), &["CdtDbtInd"]) {
        "DBIT" => Some(-cents),
        "CRDT" => Some(cents),
        _ => None,
    }
}

/// Name of a party: Nm, or Pty/Nm in the newer versions.
fn party_name(p: Option<Node<'_>>) -> &str {
    let nm = text_at(p, &["Nm"]);
    if nm.is_empty() {
        text_at(p, &["Pty", "Nm"])
    } else {
        nm
    }
}

fn account_id(acct: Option<Node<'_>>) -> String {
    let id = acct.and_then(|a| a.child("Id"));
    let iban = text_at(id, &["IBAN"]);
    let text = if iban.is_empty() { text_at(id, &["Othr", "Id"]) } else { iban };
    text.chars().filter(|c| !is_js_space(*c)).collect::<String>().to_uppercase()
}

fn first_non_empty<'a>(texts: impl IntoIterator<Item = &'a str>) -> &'a str {
    texts.into_iter().find(|t| !t.is_empty()).unwrap_or("")
}

struct Detail {
    counterparty: String,
    counterparty_iban: String,
    description: String,
    communication: String,
    reference: String,
}

/// What an entry itself says, looked up once per entry (not once per transaction of a large batch).
struct EntryInfo<'a> {
    bank_code: String,
    reference: &'a str,
    additional: &'a str,
}

fn entry_info_of<'a>(entry: Node<'a>) -> EntryInfo<'a> {
    let code = path(Some(entry), &["BkTxCd", "Domn"]);
    let parts = [text_at(code, &["Cd"]), text_at(code, &["Fmly", "Cd"]), text_at(code, &["Fmly", "SubFmlyCd"])];
    let joined = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/");
    let bank_code = if joined.is_empty() { text_at(Some(entry), &["BkTxCd", "Prtry", "Cd"]).to_owned() } else { joined };
    EntryInfo { bank_code, reference: text_at(Some(entry), &["AcctSvcrRef"]), additional: text_at(Some(entry), &["AddtlNtryInf"]) }
}

/// Names, account, remittance text and references of one transaction (one TxDtls, or the entry alone).
fn detail_of(info: &EntryInfo<'_>, tx: Option<Node<'_>>, debit: bool, single: bool, statement_iban: &str) -> Detail {
    let parties = tx.and_then(|t| t.child("RltdPties"));
    // Money out: the other side is the creditor; money in: the debtor. A reversal can list the parties the other way round,
    // so a side whose account is the statement's own is not the counterparty.
    let sides = if debit { ["Cdtr", "Dbtr"] } else { ["Dbtr", "Cdtr"] };
    let acct_of = |side: &str| account_id(parties.and_then(|p| p.child(&format!("{side}Acct"))));
    let other = if statement_iban.is_empty() {
        None
    } else {
        sides.into_iter().find(|s| {
            let iban = acct_of(s);
            !iban.is_empty() && iban != statement_iban
        })
    };
    let side = other.unwrap_or(sides[0]);
    let ultimate = if side == "Cdtr" { "UltmtCdtr" } else { "UltmtDbtr" };
    let named = party_name(parties.and_then(|p| p.child(side)));
    let counterparty = if named.is_empty() { party_name(parties.and_then(|p| p.child(ultimate))) } else { named }.to_owned();
    let own_iban = acct_of(side);
    let counterparty_iban = if own_iban.is_empty() { acct_of(ultimate) } else { own_iban };

    let rmt = tx.and_then(|t| t.child("RmtInf"));
    let unstructured: Vec<&str> =
        rmt.map_or_else(Vec::new, |r| r.kids("Ustrd")).into_iter().map(|u| u.text()).filter(|t| !t.is_empty()).collect();
    let structured = rmt.map_or_else(Vec::new, |r| r.kids("Strd"));
    let extra: Vec<&str> = structured.iter().flat_map(|s| s.kids("AddtlRmtInf")).map(|a| a.text()).filter(|t| !t.is_empty()).collect();
    let communication = first_non_empty(structured.iter().map(|s| text_at(Some(*s), &["CdtrRefInf", "Ref"]))).to_owned();
    let joined = unstructured.iter().chain(extra.iter()).copied().collect::<Vec<_>>().join(" ");
    let description = if !joined.is_empty() {
        joined
    } else {
        let candidates = [text_at(tx, &["AddtlTxInf"]), if single { info.additional } else { "" }, info.bank_code.as_str()];
        first_non_empty(candidates).to_owned()
    };

    // Only the bank's own reference is a reference. An end-to-end id is the payer's (a standing order repeats it every month)
    // and is not in a CSV export of the same history, so it is not used at all: such a row is recognised again by its date,
    // amount and text, as a CSV row is.
    let refs = tx.and_then(|t| t.child("Refs"));
    let own = text_at(refs, &["AcctSvcrRef"]);
    let reference = if own.is_empty() && single { info.reference } else { own }.to_owned();
    Detail { counterparty, counterparty_iban, description, communication, reference }
}

struct EntryResult {
    rows: Vec<CamtRow>,
    booked: bool,
}

/// Status of an entry: "BOOK" in the older layout; Sts/Cd or Sts/Prtry/Cd in version 10 and later. Missing counts as booked.
fn status_of(entry: Node<'_>) -> String {
    let e = Some(entry);
    first_non_empty([text_at(e, &["Sts"]), text_at(e, &["Sts", "Cd"]), text_at(e, &["Sts", "Prtry", "Cd"]), text_at(e, &["Sts", "Prtry"])])
        .to_uppercase()
}

fn read_entry(entry: Node<'_>, statement_currency: &str, statement_iban: &str, room: usize) -> Result<EntryResult, ImportError> {
    let status = status_of(entry);
    if !status.is_empty() && status != "BOOK" {
        return Ok(EntryResult { rows: Vec::new(), booked: false });
    }

    let amt = entry.child("Amt");
    let currency = amt.and_then(|a| a.attr("Ccy")).unwrap_or(statement_currency).to_uppercase();
    let indicator = text_at(Some(entry), &["CdtDbtInd"]);
    let debit = indicator == "DBIT";
    // Whether money came in or went out is the file's CdtDbtInd, which is the direction on the account (also for a reversal,
    // RvslInd); anything else leaves the amount empty so the row is flagged.
    let signed = |cents: Option<i64>| match cents {
        Some(c) if indicator == "CRDT" || debit => format_cents(if debit { -c } else { c }),
        _ => String::new(),
    };
    let entry_cents = amt.and_then(|a| cents_of(a.text()));
    let booking = date_of(entry.child("BookgDt"));
    let booking_date = if booking.is_empty() { date_of(entry.child("ValDt")) } else { booking };
    let value_date = date_of(entry.child("ValDt"));
    let base = |amount: String, d: Detail| CamtRow {
        booking_date: booking_date.clone(),
        value_date: value_date.clone(),
        amount,
        currency: currency.clone(),
        counterparty: d.counterparty,
        counterparty_iban: d.counterparty_iban,
        description: d.description,
        communication: d.communication,
        reference: d.reference,
    };

    let info = entry_info_of(entry);
    let txs: Vec<Node<'_>> = entry.kids("NtryDtls").into_iter().flat_map(|d| d.kids("TxDtls")).collect();
    if txs.len() > 1 {
        if txs.len() > room {
            return Err(too_large());
        }
        // A batch: one row per transaction with its own amount, when those amounts add up to the entry's.
        let own: Vec<(Node<'_>, Option<Node<'_>>)> =
            txs.iter().map(|tx| (*tx, path(Some(*tx), &["Amt"]).or_else(|| path(Some(*tx), &["AmtDtls", "TxAmt", "Amt"])))).collect();
        let cents: Vec<Option<i64>> = own.iter().map(|(_, node)| node.and_then(|n| cents_of(n.text()))).collect();
        let same_currency = own.iter().all(|(_, node)| node.and_then(|n| n.attr("Ccy")).unwrap_or(&currency).to_uppercase() == currency);
        // The sum of doubles, as JavaScript adds them.
        let sum: f64 = cents.iter().map(|c| c.map_or(0.0, |c| c as f64)).sum();
        if entry_cents.is_some_and(|e| sum == e as f64) && same_currency && cents.iter().all(Option::is_some) {
            let rows = own
                .iter()
                .zip(&cents)
                .map(|((tx, _), c)| base(signed(*c), detail_of(&info, Some(*tx), debit, false, statement_iban)))
                .collect();
            return Ok(EntryResult { booked: true, rows });
        }
        // Otherwise one row for the entry; the remittance texts of all its transactions are kept.
        let details: Vec<Detail> = txs.iter().map(|tx| detail_of(&info, Some(*tx), debit, false, statement_iban)).collect();
        let joined = details.iter().map(|d| d.description.as_str()).filter(|d| !d.is_empty()).collect::<Vec<_>>().join(" · ");
        let detail = Detail {
            counterparty: String::new(),
            counterparty_iban: String::new(),
            description: if joined.is_empty() { info.additional.to_owned() } else { joined },
            communication: String::new(),
            reference: info.reference.to_owned(),
        };
        return Ok(EntryResult { booked: true, rows: vec![base(signed(entry_cents), detail)] });
    }
    Ok(EntryResult {
        booked: true,
        rows: vec![base(signed(entry_cents), detail_of(&info, txs.first().copied(), debit, true, statement_iban))],
    })
}

fn read_statement(node: Node<'_>, budget: &mut usize) -> Result<CamtStatement, ImportError> {
    let acct = node.child("Acct");
    let iban: String = text_at(acct, &["Id", "IBAN"]).chars().filter(|c| !is_js_space(*c)).collect::<String>().to_uppercase();
    let account = if iban.is_empty() { account_id(acct) } else { iban.clone() };
    let bals: Vec<(&str, Node<'_>)> = node.kids("Bal").into_iter().map(|b| (text_at(Some(b), &["Tp", "CdOrPrtry", "Cd"]), b)).collect();
    // Opening: OPBD, else the previous day's closing (PRCD).
    let pick = |codes: &[&str]| codes.iter().find_map(|c| bals.iter().find(|(code, _)| code == c).map(|(_, b)| *b));
    let open = pick(&["OPBD", "PRCD"]);
    // Closing: CLBD, else the intraday ITBD. Never CLAV: the available balance includes a credit line.
    let close = pick(&["CLBD", "ITBD"]);
    let period = node.child("FrToDt");

    let acct_currency = text_at(acct, &["Ccy"]);
    let currency =
        if acct_currency.is_empty() { open.and_then(|o| o.child("Amt")).and_then(|a| a.attr("Ccy")).unwrap_or("") } else { acct_currency };
    let mut rows = Vec::new();
    let mut not_booked = 0;
    for entry in node.kids("Ntry") {
        let read = read_entry(entry, currency, &iban, *budget)?;
        if !read.booked {
            not_booked += 1;
        }
        // `budget.left -= rows.length`: the caller checked the room before reading a batch, so it cannot go below zero.
        *budget = budget.saturating_sub(read.rows.len());
        rows.extend(read.rows);
    }
    let day = |n: Option<Node<'_>>, tag: &str| -> Option<String> {
        let own = date_of(n.and_then(|n| n.child("Dt")));
        Some(own).filter(|d| !d.is_empty()).or_else(|| Some(iso_day(text_at(period, &[tag])).to_owned()).filter(|d| !d.is_empty()))
    };
    Ok(CamtStatement {
        account,
        is_iban: !iban.is_empty(),
        currency: currency.to_uppercase(),
        opening: open.and_then(balance_cents),
        closing: close.and_then(balance_cents),
        closing_is_final: close.is_some_and(|c| text_at(c.child("Tp"), &["CdOrPrtry", "Cd"]) == "CLBD"),
        from: day(open, "FrDtTm"),
        to: day(close, "ToDtTm"),
        rows,
        not_booked,
    })
}

/// The elements that hold one account's entries: Stmt (053), Rpt (052) and Ntfctn (054), wherever they sit.
fn statement_nodes(root: Node<'_>) -> Vec<Node<'_>> {
    let mut found = Vec::new();
    // Depth first in document order, without spreading the children (a file can have very many).
    let mut todo = vec![root];
    while let Some(n) = todo.pop() {
        if matches!(n.name(), "Stmt" | "Rpt" | "Ntfctn") {
            found.push(n);
        } else {
            todo.extend(n.children().collect::<Vec<_>>().into_iter().rev());
        }
    }
    found
}

static NAMESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"camt\.([0-9]{3})\.[0-9]{3}\.([0-9]{2})").expect("namespace regex"));

/// Reads the bytes of a CAMT file; an error with a plain explanation when it is not one. `max_rows` caps the rows
/// (the entries, and the rows a batch entry turns into).
pub fn read_camt(bytes: &[u8], max_rows: usize) -> Result<Vec<CamtStatement>, ImportError> {
    if bytes.len() > MAX_XML_BYTES {
        return Err(too_large());
    }
    let text = decode_xml(bytes)?;
    let doc = parse_xml(&text).map_err(|e| match e.failure {
        XmlFailure::Dtd => ImportError::new(
            "import.xml_dtd",
            "This XML file contains a DTD or entity definitions, which Kasboek does not read. Bank statements do not need them.",
        ),
        XmlFailure::TooLarge => too_large(),
        XmlFailure::Broken => broken(),
    })?;
    let root = doc.root();
    // The message type and version are in the namespace of the Document element, when there is one.
    let ns = root.attr_values().into_iter().find_map(|v| NAMESPACE.captures(v));
    if let Some(ns) = ns {
        if !["052", "053", "054"].contains(&&ns[1]) {
            return Err(ImportError::new("import.xml_not_camt", "This XML file is not a bank statement (CAMT.053)."));
        }
        let version: u32 = ns[2].parse().unwrap_or(0);
        if !(1..=MAX_VERSION).contains(&version) {
            return Err(ImportError::new(
                "import.xml_version",
                "This version of the CAMT format is not supported. Ask your bank for CAMT.053 version 001.02 or later.",
            ));
        }
    }
    let nodes = statement_nodes(root);
    if nodes.is_empty() {
        return Err(ImportError::new("import.xml_not_camt", "This XML file is not a bank statement (CAMT.053)."));
    }
    if nodes.len() > MAX_STATEMENTS {
        return Err(too_large());
    }
    if nodes.iter().map(|n| n.kids("Ntry").len()).sum::<usize>() > max_rows {
        return Err(too_large());
    }
    // The rows of all statements together are counted while they are read, so a batch entry with very many transactions is
    // refused before its rows are built.
    let mut budget = max_rows;
    nodes.into_iter().map(|n| read_statement(n, &mut budget)).collect()
}

/// `readCamt(bytes)` with the default cap of 50,000 rows.
pub fn read_camt_default(bytes: &[u8]) -> Result<Vec<CamtStatement>, ImportError> {
    read_camt(bytes, MAX_ENTRIES)
}
