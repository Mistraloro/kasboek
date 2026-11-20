//! The balances a statement prints against its rows (`reconcile` and `runningMismatches` of src/core/pdf/statement.ts, the
//! part an XML statement and a balance column of a CSV file use too).
use serde::{Deserialize, Serialize};

/// The balances a statement states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Balances {
    pub opening: Option<i64>,
    pub closing: Option<i64>,
}

/// The first and last day a statement covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Period {
    pub from: Option<String>,
    pub to: Option<String>,
}

/// A row's amount and, when the file has it, the balance after it.
#[derive(Debug, Clone, Copy)]
pub struct Amounts {
    pub amount_cents: Option<i64>,
    pub balance_cents: Option<i64>,
}

/// How a statement's printed balances and the rows read from it agree (cents).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation {
    pub opening_cents: Option<i64>,
    pub closing_cents: Option<i64>,
    /// Sum of the rows' amounts (rows the person skipped are left out). A sum of doubles, as JavaScript adds them.
    pub sum_cents: f64,
    /// Closing minus (opening plus sum); 0 when the rows add up. `None` when a balance is missing.
    pub difference_cents: Option<f64>,
    pub rows_checked: usize,
    /// Rows whose running balance doesn't follow from the one before.
    pub running_mismatches: usize,
}

/// Rows (in file order) whose running balance doesn't follow from the one before; either direction of the file counts.
pub fn running_mismatches(rows: &[Amounts], opening: Option<i64>) -> Vec<bool> {
    fn run(list: &[Amounts], opening: Option<i64>) -> Vec<bool> {
        let mut expected = opening.map(|o| o as f64);
        list.iter()
            .map(|r| {
                let Some(amount) = r.amount_cents else { return false };
                if let Some(e) = expected.as_mut() {
                    *e += amount as f64;
                }
                let Some(balance) = r.balance_cents else { return false };
                let wrong = expected.is_some_and(|e| e != balance as f64);
                expected = Some(balance as f64);
                wrong
            })
            .collect()
    }
    let forward = run(rows, opening);
    // Newest first: the same walk from the other end.
    let reversed: Vec<Amounts> = rows.iter().rev().copied().collect();
    let mut backward = run(&reversed, opening);
    backward.reverse();
    let count = |flags: &[bool]| flags.iter().filter(|f| **f).count();
    if count(&backward) < count(&forward) {
        backward
    } else {
        forward
    }
}

/// Whether opening balance plus the rows makes the closing balance, and each running balance follows.
pub fn reconcile(rows: &[Amounts], balances: Balances) -> Reconciliation {
    let counted: Vec<Amounts> = rows.iter().copied().filter(|r| r.amount_cents.is_some()).collect();
    let sum = counted.iter().fold(0.0, |t, r| t + r.amount_cents.map_or(0.0, |a| a as f64));
    let Balances { opening, closing } = balances;
    Reconciliation {
        opening_cents: opening,
        closing_cents: closing,
        sum_cents: sum,
        difference_cents: match (opening, closing) {
            (Some(o), Some(c)) => Some(c as f64 - (o as f64 + sum)),
            _ => None,
        },
        rows_checked: counted.len(),
        running_mismatches: running_mismatches(&counted, opening).into_iter().filter(|f| *f).count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(amount: i64, balance: Option<i64>) -> Amounts {
        Amounts { amount_cents: Some(amount), balance_cents: balance }
    }

    #[test]
    fn rows_that_add_up_reconcile() {
        let r = reconcile(&[row(-4000, None), row(1550, None)], Balances { opening: Some(10_000), closing: Some(7550) });
        assert_eq!((r.sum_cents, r.difference_cents, r.rows_checked), (-2450.0, Some(0.0), 2));
        let r = reconcile(&[row(-4000, None)], Balances { opening: Some(10_000), closing: None });
        assert_eq!(r.difference_cents, None);
    }

    #[test]
    fn running_balances_are_followed_in_either_direction() {
        let oldest_first = [row(-100, Some(900)), row(-100, Some(800)), row(500, Some(1300))];
        assert_eq!(running_mismatches(&oldest_first, Some(1000)), [false, false, false]);
        let newest_first = [row(500, Some(1300)), row(-100, Some(800)), row(-100, Some(900))];
        assert_eq!(running_mismatches(&newest_first, Some(1000)), [false, false, false]);
        let wrong = [row(-100, Some(900)), row(-100, Some(850)), row(500, Some(1350))];
        assert_eq!(running_mismatches(&wrong, Some(1000)), [false, true, false]);
    }
}
