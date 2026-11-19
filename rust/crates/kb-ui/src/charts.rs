//! The numbers the Slint charts cannot compute themselves (Slint has no reduce over a model): ports of the helpers in
//! `src/renderer/src/components/charts.tsx`, plus the text alternatives the charts expose to screen readers.

/// Largest value of any month (income or spending), at least 1: `top` of `MonthBars`.
pub fn month_top(months: &[(i64, i64)]) -> f32 {
    months.iter().flat_map(|&(a, b)| [a, b]).fold(1, i64::max) as f32
}

/// Largest value of the shown rows, at least 1: `top` of `CategoryBars`.
pub fn category_top(rows: &[(String, i64)]) -> f32 {
    rows.iter().map(|r| r.1).fold(1, i64::max) as f32
}

/// `CategoryBars` shows the first `max` rows and one "Other" row with the sum of the rest (when it is above zero).
pub fn category_rows(rows: &[(String, i64)], max: usize, other: &str) -> Vec<(String, i64)> {
    let mut shown: Vec<(String, i64)> = rows.iter().take(max).cloned().collect();
    let rest: i64 = rows.iter().skip(max).map(|r| r.1).sum();
    if rest > 0 {
        shown.push((other.to_string(), rest));
    }
    shown
}

/// The value range and gridlines of `TrendLine`, computed exactly like the component does.
#[derive(Debug, Clone, PartialEq)]
pub struct TrendAxis {
    pub lo: f64,
    pub hi: f64,
    pub ticks: Vec<f64>,
}

impl TrendAxis {
    pub fn new(values: &[i64]) -> Self {
        let mut lo = values.iter().copied().fold(0, i64::min) as f64;
        let mut hi = values.iter().copied().fold(0, i64::max) as f64;
        if lo == hi {
            hi = lo + 100.0;
        }
        let span = hi - lo;
        lo -= span * 0.04;
        hi += span * 0.06;
        Self { lo, hi, ticks: nice_ticks(lo, hi) }
    }
}

/// About three round gridline values (1, 2 or 5 times a power of ten) inside lo..hi.
pub fn nice_ticks(lo: f64, hi: f64) -> Vec<f64> {
    let raw = (hi - lo) / 3.0;
    let pow = 10f64.powf(raw.log10().floor());
    let step = [1.0, 2.0, 5.0, 10.0].iter().map(|m| m * pow).find(|s| *s >= raw).unwrap_or(10.0 * pow);
    let mut out = Vec::new();
    let mut v = (lo / step).ceil() * step;
    while v <= hi {
        out.push(v);
        v += step;
    }
    out
}

/// Text alternative of a month chart: "label: income X, spending Y" per month, joined with semicolons.
pub fn month_summary(rows: &[(String, String, String)], income: &str, spending: &str) -> String {
    rows.iter().map(|(label, i, s)| format!("{label}: {income} {i}, {spending} {s}")).collect::<Vec<_>>().join("; ")
}

/// Text alternative of a trend chart: "label: value" per point, joined with semicolons.
pub fn trend_summary(rows: &[(String, String)]) -> String {
    rows.iter().map(|(label, v)| format!("{label}: {v}")).collect::<Vec<_>>().join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nice_ticks_like_typescript() {
        // net worth 0 .. 12,000.00 EUR in cents: raw step 4,000 -> 5,000
        let axis = TrendAxis::new(&[0, 250_000, 600_000, 1_200_000]);
        assert!((axis.lo + 48_000.0).abs() < 1e-6 && (axis.hi - 1_272_000.0).abs() < 1e-6);
        assert_eq!(axis.ticks, vec![0.0, 500_000.0, 1_000_000.0]);
        // all equal: hi = lo + 100
        let flat = TrendAxis::new(&[0, 0]);
        assert_eq!(flat.hi, 106.0);
        assert!(flat.lo < 0.0);
    }

    #[test]
    fn negative_values_keep_zero_in_range() {
        let axis = TrendAxis::new(&[-30_000, -10_000]);
        assert!(axis.hi > 0.0 && axis.lo < -30_000.0);
        assert!(axis.ticks.contains(&0.0) || axis.ticks.iter().any(|t| t.abs() < 1e-9));
    }

    #[test]
    fn other_row_sums_the_rest() {
        let rows: Vec<(String, i64)> = (1..=10).map(|i| (format!("c{i}"), i * 100)).collect();
        let shown = category_rows(&rows, 8, "Other");
        assert_eq!(shown.len(), 9);
        assert_eq!(shown[8], ("Other".into(), 900 + 1000));
        assert_eq!(category_rows(&rows[..3], 8, "Other").len(), 3);
        assert_eq!(category_top(&shown), 1900.0);
    }

    #[test]
    fn month_top_is_at_least_one() {
        assert_eq!(month_top(&[]), 1.0);
        assert_eq!(month_top(&[(5, 9), (7, 2)]), 9.0);
    }
}
