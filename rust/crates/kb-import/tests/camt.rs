//! The CAMT reader (ported from tests/camt.test.ts: entries, variants, refused files). Invented data; the IBANs are the
//! published examples of the standard.
use kb_import::camt::read::{cents_of, read_camt, read_camt_default, MAX_XML_BYTES};

const OWN: &str = "BE68539007547034";
const OTHER: &str = "NL91ABNA0417164300";
const NS: &str = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.02";

fn ntry(amt: &str, dir: &str, extra: &str) -> String {
    format!(
        "<Ntry><Amt Ccy=\"EUR\">{amt}</Amt><CdtDbtInd>{dir}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-03-04</Dt></BookgDt>{extra}</Ntry>"
    )
}
fn bal(code: &str, amt: &str, dir: &str, date: &str) -> String {
    format!("<Bal><Tp><CdOrPrtry><Cd>{code}</Cd></CdOrPrtry></Tp><Amt Ccy=\"EUR\">{amt}</Amt><CdtDbtInd>{dir}</CdtDbtInd><Dt><Dt>{date}</Dt></Dt></Bal>")
}
fn stmt(entries: &[String], bals: &[String]) -> String {
    format!("<Stmt><Acct><Id><IBAN>{OWN}</IBAN></Id><Ccy>EUR</Ccy></Acct>{}{}</Stmt>", bals.concat(), entries.concat())
}
fn doc(body: &str, ns: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Document xmlns=\"{ns}\"><BkToCstmrStmt>{body}</BkToCstmrStmt></Document>")
}
fn code(xml: &[u8]) -> String {
    read_camt_default(xml).err().map_or("accepted".into(), |e| e.code.to_owned())
}

#[test]
fn amounts_are_converted_exactly() {
    for (text, want) in [
        ("12.50", Some(1250)),
        ("12", Some(1200)),
        ("0.1", Some(10)),
        ("1234567890123.45", Some(123_456_789_012_345)),
        ("0.005", Some(1)),
        (".5", Some(50)),
        ("+1.00", Some(100)),
        ("1.", Some(100)),
    ] {
        assert_eq!(cents_of(text), want, "{text}");
    }
    for bad in [".", "+", "-.5", "1,234.50", "-5", "1,5", "", "99999999999999999999"] {
        assert_eq!(cents_of(bad), None, "{bad:?}");
    }
}

#[test]
fn reads_one_statement_with_balances_signs_and_texts() {
    let pay = format!("<NtryDtls><TxDtls><Refs><AcctSvcrRef>REF-001</AcctSvcrRef></Refs><RltdPties><Cdtr><Nm>Boulangerie Dupont</Nm></Cdtr><CdtrAcct><Id><IBAN>{OTHER}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>Pain</Ustrd></RmtInf></TxDtls></NtryDtls>");
    let xml = doc(
        &stmt(
            &[ntry("45.10", "DBIT", &pay), ntry("9.00", "", "")],
            &[
                bal("OPBD", "1000.00", "CRDT", "2026-03-01"),
                bal("CLBD", "3454.90", "CRDT", "2026-03-31"),
                bal("CLAV", "1.00", "CRDT", "2026-03-10"),
            ],
        ),
        NS,
    );
    let s = &read_camt_default(xml.as_bytes()).unwrap()[0];
    assert_eq!((s.account.as_str(), s.is_iban, s.opening, s.closing, s.closing_is_final), (OWN, true, Some(100_000), Some(345_490), true));
    assert_eq!((s.from.as_deref(), s.to.as_deref()), (Some("2026-03-01"), Some("2026-03-31")));
    assert_eq!(
        (s.rows[0].amount.as_str(), s.rows[0].counterparty.as_str(), s.rows[0].counterparty_iban.as_str(), s.rows[0].reference.as_str()),
        ("-45.10", "Boulangerie Dupont", OTHER, "REF-001")
    );
    assert_eq!(s.rows[1].amount, "", "a missing indicator is never guessed");
}

#[test]
fn closing_falls_back_to_the_intraday_balance_but_never_the_available_one() {
    let xml = doc(
        &stmt(
            &[],
            &[
                bal("PRCD", "80.00", "DBIT", "2026-02-28"),
                bal("ITBD", "10.00", "CRDT", "2026-03-31"),
                bal("CLAV", "99.00", "CRDT", "2026-03-31"),
            ],
        ),
        NS,
    );
    let s = &read_camt_default(xml.as_bytes()).unwrap()[0];
    assert_eq!((s.opening, s.closing, s.closing_is_final), (Some(-8000), Some(1000), false));
}

#[test]
fn refuses_what_is_not_a_statement_with_plain_codes() {
    assert_eq!(code(b"Date;Amount\n1;2"), "import.xml_broken");
    assert_eq!(code(b""), "import.xml_broken");
    assert_eq!(code(b"<Document><Other/></Document>"), "import.xml_not_camt");
    assert_eq!(code(doc("", "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03").as_bytes()), "import.xml_not_camt");
    assert_eq!(code(doc(&stmt(&[], &[]), "urn:iso:std:iso:20022:tech:xsd:camt.053.001.99").as_bytes()), "import.xml_version");
    assert_eq!(
        code(format!("<?xml version=\"1.0\"?><!DOCTYPE d [<!ENTITY a \"b\">]>{}", doc(&stmt(&[], &[]), NS)).as_bytes()),
        "import.xml_dtd"
    );
    assert_eq!(code(&vec![0; MAX_XML_BYTES + 1]), "import.xml_too_large");
}

#[test]
fn caps_the_rows_not_only_the_entries() {
    let batch =
        ntry("1.00", "DBIT", &format!("<NtryDtls>{}</NtryDtls>", "<TxDtls><RmtInf><Ustrd>x</Ustrd></RmtInf></TxDtls>".repeat(3000)));
    let xml = doc(&stmt(&[batch], &[]), NS);
    assert_eq!(read_camt(xml.as_bytes(), 2000).unwrap_err().code, "import.xml_too_large");
    assert_eq!(read_camt(xml.as_bytes(), 5000).unwrap()[0].rows.len(), 1);
    let many = format!("<Document><X/>{}{}</Document>", "<Y/>".repeat(200_000), stmt(&[ntry("1.00", "DBIT", "")], &[]));
    assert_eq!(read_camt_default(many.as_bytes()).unwrap().len(), 1);
    assert_eq!(code(doc(&stmt(&[], &[]).repeat(1001), NS).as_bytes()), "import.xml_too_large");
}

#[test]
fn decodes_utf16_and_a_declared_latin1() {
    let text = doc(&stmt(&[ntry("1.00", "DBIT", "<AddtlNtryInf>Crème brûlée</AddtlNtryInf>")], &[]), NS);
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    let latin1: Vec<u8> = text.replace("UTF-8", "ISO-8859-1").chars().map(|c| c as u8).collect();
    for bytes in [utf16, latin1, [&[0xef, 0xbb, 0xbf][..], text.as_bytes()].concat()] {
        assert_eq!(read_camt_default(&bytes).unwrap()[0].rows[0].description, "Crème brûlée");
    }
}
