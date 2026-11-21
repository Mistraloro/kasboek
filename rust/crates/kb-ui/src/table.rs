//! The Rust side of `DataTable`: column widths for a given table width, and the selection model (click, ctrl-click,
//! shift-click and the keyboard all end in `Selection::apply`).
use crate::TableColumn;
use slint::{ModelRc, SharedString, VecModel};
use std::collections::BTreeSet;

/// How wide a column is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ColumnWidth {
    /// Logical pixels.
    Fixed(f32),
    /// A share of what the fixed columns leave, never below `min`.
    Flex { weight: f32, min: f32 },
}

/// A column of a table: header text, width rule, and whether it holds numbers (right-aligned, tabular figures).
#[derive(Debug, Clone)]
pub struct ColumnSpec {
    pub title: String,
    pub width: ColumnWidth,
    pub numeric: bool,
}

/// Widths of the columns in a table `total` wide. Flexible columns share what the fixed ones leave in proportion to their
/// weights; one that would get less than its minimum takes the minimum and the others share the rest. When even the
/// minimums do not fit they are kept (the table clips on the right).
pub fn column_widths(columns: &[ColumnWidth], total: f32) -> Vec<f32> {
    let mut widths: Vec<Option<f32>> = columns.iter().map(|c| if let ColumnWidth::Fixed(w) = c { Some(*w) } else { None }).collect();
    loop {
        let used: f32 = widths.iter().flatten().sum();
        let weights: f32 = columns
            .iter()
            .zip(&widths)
            .filter(|(_, w)| w.is_none())
            .map(|(c, _)| if let ColumnWidth::Flex { weight, .. } = c { *weight } else { 0.0 })
            .sum();
        let share = (total - used).max(0.0) / weights.max(f32::EPSILON);
        let mut frozen = false;
        for (c, w) in columns.iter().zip(widths.iter_mut()) {
            if let (ColumnWidth::Flex { weight, min }, None) = (c, &*w) {
                if weight * share < *min {
                    *w = Some(*min);
                    frozen = true;
                }
            }
        }
        if !frozen {
            return columns
                .iter()
                .zip(&widths)
                .map(|(c, w)| match (c, w) {
                    (ColumnWidth::Flex { weight, .. }, None) => weight * share,
                    (_, w) => w.unwrap_or(0.0),
                })
                .collect();
        }
    }
}

/// The `columns` model of a `DataTable` for a table `total` wide (the `layout-requested` callback of the table says how wide).
pub fn columns_model(specs: &[ColumnSpec], total: f32) -> ModelRc<TableColumn> {
    let widths: Vec<ColumnWidth> = specs.iter().map(|c| c.width).collect();
    let columns: Vec<TableColumn> = specs
        .iter()
        .zip(column_widths(&widths, total))
        .map(|(c, width)| TableColumn { title: SharedString::from(c.title.as_str()), width, numeric: c.numeric })
        .collect();
    ModelRc::new(VecModel::from(columns))
}

/// What the person did to a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gesture {
    /// Plain click or arrow key: only this row.
    Only,
    /// Ctrl/Cmd-click, the box, Space: flip this row.
    Toggle,
    /// Shift-click, Shift+arrow: from the anchor to this row.
    Range,
    /// Ctrl+Shift-click: add the range from the anchor to this row.
    AddRange,
}

impl Gesture {
    pub fn from_modifiers(shift: bool, toggle: bool) -> Self {
        match (shift, toggle) {
            (true, true) => Gesture::AddRange,
            (true, false) => Gesture::Range,
            (false, true) => Gesture::Toggle,
            (false, false) => Gesture::Only,
        }
    }
}

/// Selected row numbers and the anchor of a shift-range.
#[derive(Debug, Default, Clone)]
pub struct Selection {
    rows: BTreeSet<usize>,
    anchor: Option<usize>,
}

impl Selection {
    pub fn apply(&mut self, row: usize, gesture: Gesture) {
        match gesture {
            Gesture::Only => {
                self.rows.clear();
                self.rows.insert(row);
                self.anchor = Some(row);
            }
            Gesture::Toggle => {
                if !self.rows.remove(&row) {
                    self.rows.insert(row);
                }
                self.anchor = Some(row);
            }
            Gesture::Range | Gesture::AddRange => {
                let anchor = *self.anchor.get_or_insert(row);
                if gesture == Gesture::Range {
                    self.rows.clear();
                }
                self.rows.extend(anchor.min(row)..=anchor.max(row));
            }
        }
    }

    pub fn select_all(&mut self, rows: usize) {
        self.rows = (0..rows).collect();
        self.anchor = None;
    }

    pub fn clear(&mut self) {
        self.rows.clear();
        self.anchor = None;
    }

    pub fn contains(&self, row: usize) -> bool {
        self.rows.contains(&row)
    }

    pub fn count(&self) -> usize {
        self.rows.len()
    }

    /// The selected rows, ascending.
    pub fn rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.rows.iter().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ColumnWidth::{Fixed, Flex};

    #[test]
    fn flexible_columns_share_the_rest() {
        let w = column_widths(&[Fixed(100.0), Flex { weight: 2.0, min: 50.0 }, Flex { weight: 1.0, min: 50.0 }, Fixed(120.0)], 820.0);
        assert_eq!(w, vec![100.0, 400.0, 200.0, 120.0]);
    }

    #[test]
    fn a_narrow_table_keeps_the_minimums() {
        let cols = [Fixed(100.0), Flex { weight: 3.0, min: 160.0 }, Flex { weight: 1.0, min: 80.0 }];
        // 400 wide: 300 left, 3:1 would be 225/75, the second flex column takes its minimum 80 and the first the rest.
        assert_eq!(column_widths(&cols, 400.0), vec![100.0, 220.0, 80.0]);
        // Too narrow for the minimums: they are kept.
        assert_eq!(column_widths(&cols, 200.0), vec![100.0, 160.0, 80.0]);
    }

    #[test]
    fn no_flexible_column_means_fixed_widths() {
        assert_eq!(column_widths(&[Fixed(10.0), Fixed(20.0)], 1000.0), vec![10.0, 20.0]);
        assert!(column_widths(&[], 100.0).is_empty());
    }

    #[test]
    fn plain_toggle_and_range() {
        let mut s = Selection::default();
        s.apply(5, Gesture::Only);
        s.apply(8, Gesture::Range);
        assert_eq!(s.rows().collect::<Vec<_>>(), vec![5, 6, 7, 8]);
        // A shorter range from the same anchor replaces the first.
        s.apply(3, Gesture::Range);
        assert_eq!(s.rows().collect::<Vec<_>>(), vec![3, 4, 5]);
        s.apply(10, Gesture::Toggle);
        s.apply(4, Gesture::Toggle);
        assert_eq!(s.rows().collect::<Vec<_>>(), vec![3, 5, 10]);
        // The anchor moved to the last toggled row.
        s.apply(2, Gesture::AddRange);
        assert_eq!(s.rows().collect::<Vec<_>>(), vec![2, 3, 4, 5, 10]);
        s.apply(7, Gesture::Only);
        assert_eq!((s.count(), s.contains(7), s.contains(5)), (1, true, false));
    }

    #[test]
    fn a_range_without_anchor_is_the_row() {
        let mut s = Selection::default();
        s.apply(4, Gesture::Range);
        assert_eq!(s.rows().collect::<Vec<_>>(), vec![4]);
    }

    #[test]
    fn select_all_and_clear() {
        let mut s = Selection::default();
        s.select_all(500_000);
        assert_eq!((s.count(), s.contains(499_999), s.contains(500_000)), (500_000, true, false));
        s.clear();
        assert_eq!(s.count(), 0);
    }
}
