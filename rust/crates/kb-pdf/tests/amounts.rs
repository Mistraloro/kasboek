//! A hostile statement: over a thousand rows with the largest amount that is still a safe integer (9,007,199,254,740,991
//! cents), and balances of that size. Summing them must not overflow or panic (the sums are doubles, as in JavaScript).
use kb_import::amount::{parse_amount, Decimal};
use kb_import::statement::{reconcile, Amounts};
use kb_pdf::{read_statement, PdfCell, PdfLine};

const MAX: &str = "90.071.992.547.409,91";

fn line(id: usize, cells: &[&str]) -> PdfLine {
    let cells = cells
        .iter()
        .enumerate()
        .map(|(i, t)| PdfCell { text: (*t).to_string(), x0: i as f64 * 100.0, x1: i as f64 * 100.0 + 90.0 })
        .collect();
    PdfLine { id, page: 1, y: 800.0 - id as f64 * 0.5, page_height: Some(842.0), cells }
}

#[test]
fn a_thousand_maximal_amounts_do_not_overflow() {
    let mut lines = vec![line(0, &["Datum", "Omschrijving", "Bedrag", "Saldo"])];
    for i in 1..=1200 {
        lines.push(line(i, &["01/11/2026", "Shop", MAX, MAX]));
    }
    lines.push(line(1201, &["Opening balance", MAX]));
    lines.push(line(1202, &["Closing balance", MAX]));
    let read = read_statement(&lines, None);
    assert!(read.header_found);
    assert_eq!(read.grid.len(), 1201);
    let rows: Vec<Amounts> =
        read.grid[1..].iter().map(|r| Amounts { amount_cents: parse_amount(&r[2], Decimal::Comma, ','), balance_cents: None }).collect();
    assert!(rows.iter().all(|r| r.amount_cents == Some(9_007_199_254_740_991)));
    let total = reconcile(&rows, read.balances);
    assert_eq!(total.rows_checked, 1200);
    assert!(total.sum_cents.is_finite() && total.sum_cents > 1e18);
    assert!(total.difference_cents.is_some_and(f64::is_finite));
}
