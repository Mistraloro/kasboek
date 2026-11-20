//! The grid an XML statement is turned into, and the choice of which statements of a file belong to the chosen account
//! (the part of `openXmlSession` in src/core/camt/open.ts that needs no database).
use super::read::{CamtRow, CamtStatement};
use crate::csv::mapping::{Columns, DateOrder, Mapping};
use crate::error::ImportError;
use crate::jsstr::is_js_space;
use crate::statement::{Balances, Period};
use serde::Serialize;

/// A remark about an XML statement, as a code the screen words in the person's language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum XmlNote {
    OtherAccount { iban: String },
    AccountsLeftOut { count: usize },
    NotBooked { count: usize },
}

/// The columns of the grid an XML statement is turned into (the header names are Kasboek's own).
const HEADER: [&str; 9] =
    ["Booking date", "Value date", "Amount", "Currency", "Counterparty", "Counterparty IBAN", "Description", "Communication", "Reference"];

/// The fixed mapping of that grid: its columns are known, not detected.
pub fn xml_mapping() -> Mapping {
    Mapping {
        delimiter: ',',
        header_row: 0,
        date_order: DateOrder::Ymd,
        decimal: '.',
        invert_sign: false,
        columns: Columns {
            booking_date: 0,
            value_date: Some(1),
            amount: Some(2),
            debit: None,
            credit: None,
            direction: None,
            currency: Some(3),
            counterparty_name: Some(4),
            counterparty_iban: Some(5),
            description: vec![6],
            communication: Some(7),
            bank_reference: Some(8),
            status: None,
            balance: None,
        },
    }
}

/// What an XML statement adds to its session: the balances it states and its remarks.
#[derive(Debug, Clone)]
pub struct XmlSessionData {
    pub balances: Balances,
    /// Whether the closing balance is the real closing balance (CLBD); only then is it recorded as the bank's balance.
    pub closing_is_final: bool,
    pub period: Period,
    pub notes: Vec<XmlNote>,
}

fn grid_row(r: CamtRow) -> Vec<String> {
    vec![
        r.booking_date,
        r.value_date,
        r.amount,
        r.currency,
        r.counterparty,
        r.counterparty_iban,
        r.description,
        r.communication,
        r.reference,
    ]
}

fn compact(iban: Option<&str>) -> String {
    iban.unwrap_or("").chars().filter(|c| !is_js_space(*c)).collect::<String>().to_uppercase()
}

/// A file can hold several accounts: the statements of the chosen account are used (matched by IBAN). When both IBANs are known
/// and differ the file is refused, so rows never land in the wrong account; when only the chosen account's IBAN is not known,
/// the file is used with a remark. Statements are also kept apart by currency: only those in the chosen account's currency are
/// used, and currencies are never merged. Returns the grid (header row first) and what the statement says about itself.
pub fn plan_xml(
    statements: Vec<CamtStatement>,
    account_iban: Option<&str>,
    account_currency: &str,
) -> Result<(Vec<Vec<String>>, XmlSessionData), ImportError> {
    let own = compact(account_iban);
    // By account, in the order the accounts first appear.
    let mut accounts: Vec<(String, Vec<CamtStatement>)> = Vec::new();
    for st in statements {
        match accounts.iter_mut().find(|(a, _)| *a == st.account) {
            Some((_, list)) => list.push(st),
            None => accounts.push((st.account.clone(), vec![st])),
        }
    }

    let mut notes = Vec::new();
    let of_account: Vec<CamtStatement>;
    let own_at = (!own.is_empty()).then(|| accounts.iter().position(|(a, _)| *a == own)).flatten();
    if let Some(at) = own_at {
        let left_out = accounts.len() - 1;
        of_account = accounts.swap_remove(at).1;
        if left_out > 0 {
            notes.push(XmlNote::AccountsLeftOut { count: left_out });
        }
    } else if accounts.len() == 1 {
        of_account = accounts.swap_remove(0).1;
        let first = &of_account[0];
        if first.is_iban && !first.account.is_empty() {
            if !own.is_empty() {
                return Err(ImportError::new(
                    "import.xml_iban_mismatch",
                    "The IBAN in this file is not the IBAN of the chosen account. Choose the account this file belongs to.",
                ));
            }
            notes.push(XmlNote::OtherAccount { iban: kb_rules::iban::mask_iban(&first.account) });
        }
    } else {
        return Err(ImportError::new(
            "import.xml_accounts",
            "This file holds statements for more than one account, and none of them is the chosen account. Add the account’s IBAN in Settings, choose that account and open the file again.",
        ));
    }

    // One currency only: the chosen account's (a statement that does not name its currency counts as that).
    let currency = account_currency.to_uppercase();
    let (exact, unnamed): (Vec<CamtStatement>, Vec<CamtStatement>) = of_account.into_iter().partition(|st| st.currency == currency);
    let mut chosen = if exact.is_empty() { unnamed.into_iter().filter(|st| st.currency.is_empty()).collect() } else { exact };
    if chosen.is_empty() {
        return Err(ImportError::new(
            "import.xml_currency",
            "This file is in another currency than the chosen account. Choose the account in that currency.",
        ));
    }

    // Statements of one account in date order: the first one's opening and the last one's closing balance count.
    let key = |st: &CamtStatement| st.from.clone().or_else(|| st.rows.first().map(|r| r.booking_date.clone())).unwrap_or_default();
    chosen.sort_by_cached_key(key);
    let not_booked: usize = chosen.iter().map(|st| st.not_booked).sum();
    if not_booked > 0 {
        notes.push(XmlNote::NotBooked { count: not_booked });
    }
    let mut from: Vec<&String> = chosen.iter().filter_map(|st| st.from.as_ref()).collect();
    from.sort();
    let mut to: Vec<&String> = chosen.iter().filter_map(|st| st.to.as_ref()).collect();
    to.sort();
    let last = chosen.last().expect("at least one statement");
    let data = XmlSessionData {
        balances: Balances { opening: chosen[0].opening, closing: last.closing },
        closing_is_final: last.closing_is_final,
        period: Period { from: from.first().map(|s| (*s).clone()), to: to.last().map(|s| (*s).clone()) },
        notes,
    };
    let mut grid = vec![HEADER.iter().map(|h| (*h).to_owned()).collect::<Vec<_>>()];
    grid.extend(chosen.into_iter().flat_map(|st| st.rows.into_iter().map(grid_row)));
    Ok((grid, data))
}
