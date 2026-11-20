//! Column mapping: which CSV column means what, plus the date order and decimal mark (src/core/csv/mapping.ts). Detected from
//! the header names and checked against the data. The names cover the exports of many banks and payment apps in English,
//! Dutch, French, German, Spanish, Portuguese and Italian; anything else is mapped by hand or by the assistant's check.
use super::read::norm_header;
use crate::error::ImportError;
use crate::jsstr::{js_number, js_trim, JS_SPACE};
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;

/// Which column holds what. Optional columns are left out of the JSON when absent, and the keys keep the order of
/// `mappingSchema` (it is stored as text in the saved layouts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Columns {
    pub booking_date: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_date: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<usize>,
    /// Whether the amount is money out or in, as its own column ("Af/Bij", "S/H", "Debit/Credit").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterparty_name: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterparty_iban: Option<usize>,
    pub description: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub communication: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank_reference: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<usize>,
    /// The account balance after each transaction, when the bank includes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<usize>,
}

impl Columns {
    /// Every column index the mapping points at.
    pub fn used(&self) -> impl Iterator<Item = usize> + '_ {
        [
            Some(self.booking_date),
            self.value_date,
            self.amount,
            self.debit,
            self.credit,
            self.direction,
            self.currency,
            self.counterparty_name,
            self.counterparty_iban,
            self.communication,
            self.bank_reference,
            self.status,
        ]
        .into_iter()
        .flatten()
        .chain(self.description.iter().copied())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DateOrder {
    #[serde(rename = "DMY")]
    Dmy,
    #[serde(rename = "YMD")]
    Ymd,
    #[serde(rename = "MDY")]
    Mdy,
}

/// `ImportMapping` of src/shared/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub delimiter: char,
    pub header_row: usize,
    pub date_order: DateOrder,
    pub decimal: char,
    pub invert_sign: bool,
    pub columns: Columns,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Ignore,
    BookingDate,
    ValueDate,
    Amount,
    Debit,
    Credit,
    Direction,
    Currency,
    CounterpartyName,
    CounterpartyIban,
    Description,
    Communication,
    BankReference,
    Status,
    Balance,
}

fn synonyms(field: Field) -> &'static [&'static str] {
    SYNONYMS.iter().find(|(f, _)| *f == field).map_or(&[], |(_, names)| names)
}

/// What a direction column says: money out or in.
pub fn direction_of(text: &str) -> Option<i64> {
    let v = norm_header(text);
    let t = js_trim(text);
    if matches!(
        v.as_str(),
        "af" | "debet" | "debit" | "d" | "dr" | "s" | "soll" | "out" | "uit" | "debito" | "cargo" | "withdrawal" | "uitgaand" | "-"
    ) || t == "-"
    {
        return Some(-1);
    }
    if matches!(v.as_str(), "bij" | "credit" | "c" | "cr" | "h" | "haben" | "in" | "credito" | "abono" | "deposit" | "inkomend" | "+")
        || t == "+"
    {
        return Some(1);
    }
    None
}

static ALL_SYNONYMS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| SYNONYMS.iter().flat_map(|(_, names)| names.iter().copied()).collect());

fn score_header_row(cells: &[String]) -> usize {
    cells.iter().filter(|c| ALL_SYNONYMS.contains(norm_header(c).as_str())).count()
}

/// First row that looks like a header (bank exports may start with a few info lines).
pub fn find_header_row(rows: &[Vec<String>]) -> usize {
    let mut best = 0;
    let mut best_score = 0;
    for (i, r) in rows.iter().take(15).enumerate() {
        let s = score_header_row(r);
        if s > best_score {
            best = i;
            best_score = s;
        }
    }
    if best_score >= 2 {
        best
    } else {
        0
    }
}

static IBAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]{2}[0-9]{2}[A-Za-z0-9 ]{10,30}$").expect("iban regex"));
static DATEISH: LazyLock<Regex> = LazyLock::new(|| {
    let any = r"[^\n\r\u2028\u2029]*";
    Regex::new(&format!(
        r"^[0-9]{{1,4}}[-/.][0-9]{{1,2}}[-/.][0-9]{{1,4}}(?: {any})?$|^[0-9]{{8}}$|^[0-9]{{1,2}}[ -][A-Za-z]{{3,9}}\.?[ -][0-9]{{2,4}}$|^[A-Za-z]{{3,9}}\.? [0-9]{{1,2}},? [0-9]{{4}}$"
    ))
    .expect("date-ish regex")
});
static THREE_LETTERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{3}$").expect("currency regex"));
static YEAR_FIRST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}[-/.]").expect("year regex"));
static EIGHT_DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{8}$").expect("digits regex"));
static COMMA_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",[0-9]{1,2}-?$").expect("comma regex"));
static DOT_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[0-9]{1,2}-?$").expect("dot regex"));
static SIDE_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[{JS_SPACE}]*(?-u:\b)(?:[dD][rR]|[cC][rR])\.?$")).expect("side regex"));

/// The maximum of description columns `mappingSchema` allows.
const MAX_DESCRIPTION_COLUMNS: usize = 6;

/// The mapping detected from the header names and the data. `Ok(None)` when no date and amount column is found. A file
/// with more description columns than the schema allows fails the way `mappingSchema.parse` does in TypeScript.
pub fn auto_map(rows: &[Vec<String>], delimiter: char) -> Result<Option<Mapping>, ImportError> {
    let header_row = find_header_row(rows);
    let headers: Vec<String> = rows.get(header_row).map(|r| r.iter().map(|c| norm_header(c)).collect()).unwrap_or_default();
    let data = rows.get(header_row + 1..).unwrap_or_default();
    let data = &data[..data.len().min(39)];
    let mut used: HashSet<usize> = HashSet::new();
    let mut cols = [None::<usize>; 15];
    let mut description: Vec<usize> = Vec::new();
    let column_values =
        |i: usize| -> Vec<&str> { data.iter().map(|r| r.get(i).map_or("", String::as_str)).filter(|v| !v.is_empty()).collect() };

    let claim = |field: Field, exact_only: bool, used: &mut HashSet<usize>, cols: &mut [Option<usize>; 15]| {
        // Partial matches only for longer names, and never for columns we ignore.
        if !exact_only && field == Field::Ignore {
            return;
        }
        for syn in synonyms(field) {
            if !exact_only && syn.len() < 5 {
                continue;
            }
            let found =
                headers.iter().enumerate().position(|(idx, h)| !used.contains(&idx) && if exact_only { h == syn } else { h.contains(syn) });
            if let Some(i) = found {
                used.insert(i);
                if field != Field::Ignore {
                    cols[field as usize] = Some(i);
                }
                return;
            }
        }
    };
    const ORDER: [Field; 14] = [
        Field::Ignore,
        Field::BookingDate,
        Field::ValueDate,
        Field::Currency,
        Field::CounterpartyName,
        Field::CounterpartyIban,
        Field::Amount,
        Field::Debit,
        Field::Credit,
        Field::Direction,
        Field::Communication,
        Field::BankReference,
        Field::Status,
        Field::Balance,
    ];
    for exact in [true, false] {
        for f in ORDER {
            if f == Field::Ignore || cols[f as usize].is_none() {
                claim(f, exact, &mut used, &mut cols);
            }
        }
    }
    for syn in synonyms(Field::Description) {
        if let Some(i) = headers.iter().enumerate().position(|(idx, h)| !used.contains(&idx) && h == syn) {
            used.insert(i);
            description.push(i);
        }
    }

    let at = |f: Field, cols: &[Option<usize>; 15]| cols[f as usize];
    // A "counterparty" column full of IBANs is the account, not the name (and the other way round).
    let looks_iban = |i: Option<usize>| {
        i.is_some_and(|i| {
            let v = column_values(i);
            v.iter().filter(|x| IBAN.is_match(x)).count() * 2 > v.len()
        })
    };
    if at(Field::CounterpartyName, &cols).is_some()
        && looks_iban(at(Field::CounterpartyName, &cols))
        && at(Field::CounterpartyIban, &cols).is_none()
    {
        cols[Field::CounterpartyIban as usize] = cols[Field::CounterpartyName as usize];
        cols[Field::CounterpartyName as usize] = None;
    }
    // A direction column only counts when its values say out or in ("Af"/"Bij", "S"/"H", ...).
    if let Some(d) = at(Field::Direction, &cols) {
        let v = column_values(d);
        if v.is_empty() || (v.iter().filter(|x| direction_of(x).is_some()).count() as f64) < v.len() as f64 * 0.8 {
            cols[Field::Direction as usize] = None;
        }
    }
    // "Valuta" is the value date in Dutch but the currency in Italian: three-letter codes mean currency.
    if let (Some(v), None) = (at(Field::ValueDate, &cols), at(Field::Currency, &cols)) {
        let values = column_values(v);
        if !values.is_empty() && values.iter().all(|x| THREE_LETTERS.is_match(x)) {
            cols[Field::Currency as usize] = Some(v);
            cols[Field::ValueDate as usize] = None;
        }
    }
    // No date header recognised: take the first column that holds dates.
    if at(Field::BookingDate, &cols).is_none() {
        let found = (0..headers.len()).find(|idx| {
            let v = column_values(*idx);
            !used.contains(idx) && !v.is_empty() && v.iter().all(|x| DATEISH.is_match(x))
        });
        cols[Field::BookingDate as usize] = found;
    }
    let (amount, debit, credit) = (at(Field::Amount, &cols), at(Field::Debit, &cols), at(Field::Credit, &cols));
    let Some(booking_date) = at(Field::BookingDate, &cols) else { return Ok(None) };
    if amount.is_none() && debit.is_none() && credit.is_none() {
        return Ok(None);
    }
    if description.len() > MAX_DESCRIPTION_COLUMNS {
        return Err(ImportError::failed());
    }

    let date_samples: Vec<&str> = column_values(booking_date);
    let amount_samples: Vec<&str> = [amount, debit, credit].into_iter().flatten().flat_map(column_values).collect();
    Ok(Some(Mapping {
        delimiter,
        header_row,
        date_order: detect_date_order(&date_samples),
        decimal: detect_decimal(&amount_samples),
        invert_sign: false,
        columns: Columns {
            booking_date,
            value_date: at(Field::ValueDate, &cols),
            amount,
            debit,
            credit,
            direction: at(Field::Direction, &cols),
            currency: at(Field::Currency, &cols),
            counterparty_name: at(Field::CounterpartyName, &cols),
            counterparty_iban: at(Field::CounterpartyIban, &cols),
            description,
            communication: at(Field::Communication, &cols),
            bank_reference: at(Field::BankReference, &cols),
            status: at(Field::Status, &cols),
            balance: at(Field::Balance, &cols),
        },
    }))
}

pub fn detect_date_order<S: AsRef<str>>(samples: &[S]) -> DateOrder {
    let (mut dmy, mut mdy) = (0, 0);
    for s in samples {
        let s = s.as_ref();
        if YEAR_FIRST.is_match(s) || EIGHT_DIGITS.is_match(s) {
            return DateOrder::Ymd;
        }
        let mut parts = s.split(['-', '/', '.']).map(js_number);
        let a = parts.next().unwrap_or(f64::NAN);
        let b = parts.next();
        if a > 12.0 {
            dmy += 1;
        }
        if b.is_some_and(|b| b > 12.0) {
            mdy += 1;
        }
    }
    // Day first unless the dates show otherwise.
    if mdy > dmy {
        DateOrder::Mdy
    } else {
        DateOrder::Dmy
    }
}

pub fn detect_decimal<S: AsRef<str>>(samples: &[S]) -> char {
    let (mut comma, mut dot) = (0, 0);
    for raw in samples {
        // "12.50 DR", "(12.50)": the sign marks are not part of the number.
        let trimmed = js_trim(raw.as_ref());
        let s = SIDE_MARK.replace(trimmed, "");
        let s = s.strip_suffix(')').unwrap_or(&s);
        if COMMA_END.is_match(s) {
            comma += 1;
        } else if DOT_END.is_match(s) {
            dot += 1;
        }
    }
    if dot > comma {
        '.'
    } else {
        ','
    }
}

/// Recognises well-known layouts from their header rows, to report "layout recognised". This is only a label: any bank's CSV
/// is mapped from its column names by `auto_map`.
pub fn detect_layout(header_cells: &[String]) -> Option<&'static str> {
    let h: HashSet<String> = header_cells.iter().map(|c| norm_header(c)).collect();
    LAYOUTS.iter().find(|(_, sets)| sets.iter().any(|set| set.iter().all(|x| h.contains(*x)))).map(|(name, _)| *name)
}

/// The key a saved layout is found by: the delimiter (or `pdf`) and the normalised header names.
pub fn header_signature(cells: &[String], delimiter: &str) -> String {
    format!("{delimiter}|{}", cells.iter().map(|c| norm_header(c)).collect::<Vec<_>>().join("|"))
}

/// Header names per field (as `norm_header` writes them), most specific first, in the order of the TypeScript table.
const SYNONYMS: &[(Field, &[&str])] = &[
    (
        Field::Ignore,
        &[
            "nr v/d rekening",
            "rekeningnummer",
            "rekening",
            "naam van de rekening",
            "rubrieknaam",
            "iban/bban",
            "numero de compte",
            "compte",
            "account",
            "account number",
            "account name",
            "iban rekening",
            "auftragskonto",
            "konto",
            "accountnum",
            "accountlabel",
            "product",
            "card no",
            "card number",
            "card last four digits",
            "sort code",
            "bic",
            "bic tegenpartij",
            "bic (swift code)",
            "beginsaldo",
            "original amount",
            "original currency",
            "local amount",
            "local currency",
            "exchange rate",
            "gross",
            "brutto",
            "fee",
            "fees",
            "total fees",
            "mandatsreferenz",
            "glaubiger id",
            "glaeubiger id",
            "fremde gebuhren",
            "lastschrift ursprungsbetrag",
            "auslagenersatz rucklastschrift",
            "category",
            "categoria",
            "categorie",
            "spending category",
            "subcategory",
            "code",
            "tag",
            "emoji",
            "receipt",
            "time",
            "timezone",
        ],
    ),
    (
        Field::BookingDate,
        &[
            "boekingsdatum",
            "boekdatum",
            "transactiedatum",
            "uitvoeringsdatum",
            "datum",
            "date d execution",
            "date de comptabilisation",
            "date comptable",
            "date operation",
            "date de l operation",
            "dateop",
            "booking date",
            "posting date",
            "posted date",
            "post date",
            "transaction date",
            "trans date",
            "completed date",
            "date posted",
            "buchungstag",
            "buchungsdatum",
            "fecha operacion",
            "f operacion",
            "fecha",
            "data movimento",
            "data mov",
            "data lancamento",
            "data operazione",
            "data contabile",
            "data",
            "date",
        ],
    ),
    (
        Field::ValueDate,
        &[
            "valutadatum",
            "rentedatum",
            "valuta",
            "date valeur",
            "date de valeur",
            "dateval",
            "value date",
            "valeur",
            "wertstellung",
            "wert",
            "interest date",
            "started date",
            "fecha valor",
            "f valor",
            "data valor",
            "data valuta",
        ],
    ),
    (
        Field::Amount,
        &[
            "bedrag",
            "bedrag (eur)",
            "bedrag in eur",
            "transactiebedrag",
            "montant",
            "montant (eur)",
            "montant de l operation",
            "amount",
            "amount (eur)",
            "amount (gbp)",
            "amount (usd)",
            "transaction amount",
            "betrag",
            "betrag (eur)",
            "betrag ( )",
            "importe",
            "importe ( )",
            "importe (eur)",
            "cantidad",
            "montante",
            "importo",
            "valor",
            "net",
            "netto",
        ],
    ),
    (
        Field::Debit,
        &[
            "debet",
            "debit",
            "debit amount",
            "debit euros",
            "af",
            "uitgaven",
            "soll",
            "paid out",
            "money out",
            "withdrawals",
            "withdrawal",
            "cargo",
            "cargos",
            "debito",
            "addebiti",
            "uscite",
            "ausgang",
            "opname",
            "debe",
            "debitos",
            "retraits",
        ],
    ),
    (
        Field::Credit,
        &[
            "credit",
            "krediet",
            "credit amount",
            "credit euros",
            "bij",
            "inkomsten",
            "haben",
            "paid in",
            "money in",
            "deposits",
            "deposit",
            "abono",
            "abonos",
            "credito",
            "accrediti",
            "entrate",
            "eingang",
            "ontvangsten",
            "storting",
            "haber",
            "creditos",
            "versements",
        ],
    ),
    (
        Field::Direction,
        &[
            "af bij",
            "af/bij",
            "debit/credit",
            "credit/debit",
            "debet/credit",
            "credit/debet",
            "s/h",
            "soll/haben",
            "dr/cr",
            "cr/dr",
            "sens",
            "d/c",
            "c/d",
            "debit credit",
            "debet credit",
            "credit debit indicator",
        ],
    ),
    (
        Field::Currency,
        &[
            "munt",
            "muntsoort",
            "devies",
            "munteenheid",
            "valuta rekening",
            "devise du compte",
            "devise",
            "currency",
            "currency code",
            "wahrung",
            "waehrung",
            "moneda",
            "divisa",
            "moeda",
        ],
    ),
    (
        Field::CounterpartyName,
        &[
            "naam tegenpartij",
            "naam van de tegenpartij",
            "tegenpartij naam",
            "naam / omschrijving",
            "nom de la contrepartie",
            "nom contrepartie",
            "counterparty name",
            "partner name",
            "merchant",
            "payee name",
            "payer name",
            "counter party",
            "begunstigter / auftraggeber",
            "auftraggeber / begunstigter",
            "beguenstigter/zahlungspflichtiger",
            "begunstigter/zahlungspflichtiger",
            "zahlungsempfanger in",
            "zahlungsempfanger",
            "empfanger",
            "supplierfound",
            "beneficiario",
            "ordenante",
            "contraparte",
            "beneficiaire",
            "tiers",
            "counterparty",
            "begunstigde",
            "payee",
            "beneficiary",
            "name",
            "naam",
            "nome",
        ],
    ),
    (
        Field::CounterpartyIban,
        &[
            "rekening tegenpartij",
            "rekeningnummer tegenpartij",
            "iban tegenpartij",
            "tegenrekening iban/bban",
            "tegenrekening",
            "tegenpartij",
            "compte contrepartie",
            "compte de la contrepartie",
            "iban contrepartie",
            "contrepartie",
            "counterparty account",
            "counterparty iban",
            "partner iban",
            "payee account number",
            "kontonummer/iban",
            "iban",
            "cuenta contrapartida",
        ],
    ),
    (
        Field::Description,
        &[
            "omschrijving",
            "omschrijving 1",
            "omschrijving 2",
            "omschrijving 3",
            "beschrijving",
            "details",
            "detail van de omzet",
            "mutatiesoort",
            "transactie",
            "description",
            "transaction description",
            "libelle",
            "label",
            "detail de l ecriture",
            "type verrichting",
            "type de transaction",
            "transaction type",
            "buchungstext",
            "umsatzart",
            "umsatztyp",
            "verwendungszweck",
            "memo",
            "narrative",
            "omschrijving transactie",
            "particulars",
            "transaction details",
            "vorgang",
            "nature de l operation",
            "libelle de l operation",
            "concepto",
            "descripcion",
            "movimiento",
            "descricao",
            "descrizione",
            "operazione",
            "dettagli",
            "causale",
            "lancamento",
            "type",
        ],
    ),
    (
        Field::Communication,
        &[
            "mededeling",
            "mededelingen",
            "bericht",
            "communication",
            "vrije mededeling",
            "gestructureerde mededeling",
            "message",
            "reference de paiement",
            "payment reference",
            "notes and #tags",
            "note",
            "notes",
        ],
    ),
    (
        Field::BankReference,
        &[
            "transactienummer",
            "omzetnummer",
            "referentie",
            "reference",
            "volgnummer",
            "volgnr",
            "numero de sequence",
            "uittrekselnummer",
            "extrait",
            "transactie id",
            "transaction id",
            "transferwise id",
            "kundenreferenz",
            "kundenreferenz (end to end)",
            "identificador",
            "referencia",
            "check or slip",
            "transaction reference",
            "id",
        ],
    ),
    (Field::Status, &["status", "statut", "state", "estado", "stato"]),
    (
        Field::Balance,
        &[
            "saldo",
            "solde",
            "balance",
            "kontostand",
            "saldo na verrichting",
            "saldo na transactie",
            "saldo na mutatie",
            "saldo na trn",
            "nieuw saldo",
            "eindsaldo",
            "solde apres operation",
            "solde apres transaction",
            "running balance",
            "running bal",
            "balance after",
            "saldo rekening",
            "accountbalance",
            "balance (gbp)",
            "balance (eur)",
            "saldo contabilistico",
            "saldo contabile",
            "saldo disponible",
        ],
    ),
];

/// Well-known exports, by header names that only they have together. Only a label ("layout recognised").
const LAYOUTS: &[(&str, &[&[&str]])] = &[
    ("argenta", &[&["nr v/d rekening"], &["boekdatum", "naam tegenpartij", "munt"]]),
    ("hellobank", &[&["volgnummer", "uitvoeringsdatum"], &["numero de sequence", "date d execution"]]),
    ("keytrade", &[&["uittrekselnummer"], &["extrait", "devise"]]),
    ("kbc", &[&["rubrieknaam", "afschriftnummer"]]),
    ("belfius", &[&["rekeninguittrekselnummer", "naam tegenpartij bevat"]]),
    ("ing-be", &[&["omzetnummer", "detail van de omzet"]]),
    ("ing-nl", &[&["naam / omschrijving", "af bij"]]),
    ("rabobank", &[&["iban/bban", "volgnr", "saldo na trn"]]),
    ("abn-amro", &[&["transactiedatum", "transactiebedrag", "muntsoort"]]),
    ("deutsche-bank", &[&["begunstigter / auftraggeber", "umsatzart"]]),
    ("sparkasse", &[&["auftragskonto", "beguenstigter/zahlungspflichtiger"]]),
    ("dkb", &[&["zahlungsempfanger in", "wertstellung"]]),
    ("n26", &[&["partner name", "partner iban"]]),
    ("revolut", &[&["started date", "completed date", "product"]]),
    ("wise", &[&["transferwise id"]]),
    ("paypal", &[&["gross", "fee", "net", "transaction id"]]),
    ("monzo", &[&["money out", "money in", "local amount"]]),
    ("lloyds", &[&["sort code", "debit amount", "credit amount"]]),
    ("chase", &[&["posting date", "check or slip"]]),
    ("boursorama", &[&["dateop", "dateval", "supplierfound"]]),
];
