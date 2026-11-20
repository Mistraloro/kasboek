//! The cell rules the statement reader takes from `kb-import` (dates, amounts, decimal marks, header names) against the
//! answers of the TypeScript (`tests/fixtures/csvrules.json`, written by rust/parity/pdf.spec.ts).
use kb_import::amount::{parse_amount, Decimal};
use kb_import::csv::mapping::{detect_decimal, header_field, score_header_row, DateOrder};
use kb_import::csv::normalize::parse_date;
use kb_import::csv::read::norm_header;
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/csvrules.json")).unwrap()
}

/// The camelCase key of a field, as the fixtures and the TypeScript write it.
fn key(f: kb_import::csv::mapping::Field) -> String {
    let name = format!("{f:?}");
    name[..1].to_lowercase() + &name[1..]
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
        let decimal = match c["decimal"].as_str().unwrap().chars().next() {
            Some('.') => Decimal::Dot,
            Some(',') => Decimal::Comma,
            _ => Decimal::Auto,
        };
        assert_eq!(parse_amount(input, decimal, ','), c["result"].as_i64(), "parseAmount({input:?}, {decimal:?})");
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
        assert_eq!(header_field(input).map(key).as_deref(), c["field"].as_str(), "headerField({input:?})");
        assert_eq!(score_header_row(&[input, input]), c["score"].as_u64().unwrap() as usize, "scoreHeaderRow({input:?})");
    }
}
