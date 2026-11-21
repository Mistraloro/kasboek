//! A fake ledger for the gallery's live `DataTable` case and the scroll test: rows made up from their number, so a
//! 500,000-row source costs nothing to hold, behind the same `PagedModel` the pages use.
use crate::amount::{format_amount, AmountFormat};
use crate::paged::{PageSource, PagedModel};
use crate::table::{columns_model, ColumnSpec, ColumnWidth, Gesture, Selection};
use crate::{Gallery, TableDemo, TableRowData};
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const WORDS: [&str; 8] = ["Supermarket", "Landlord", "Salary", "Water bill", "Train ticket", "Bakery", "Gym", "Pharmacy"];
const CATEGORIES: [&str; 5] = ["Groceries", "Rent", "Income", "Utilities", "Transport"];

/// Transaction `n` of the fake ledger, newest first.
pub fn fake_row(n: usize) -> TableRowData {
    let (day, month, year) = (28 - n % 28, 12 - (n / 28) % 12, 2026 - n / 336);
    let cents = (n as i64 * 7919 % 250_000) * if n % 5 == 2 { 1 } else { -1 };
    let (date, what, category) =
        (format!("{day:02}/{month:02}/{year}"), format!("{} no. {n}", WORDS[n % WORDS.len()]), CATEGORIES[n % CATEGORIES.len()]);
    let amount = format_amount(cents, &AmountFormat::EN);
    let label = format!("{date}, {what}, {category}, {}", amount.replacen('-', "minus ", 1));
    let cells: Vec<SharedString> = vec![date.into(), what.into(), category.into(), amount.into()];
    TableRowData { cells: ModelRc::new(VecModel::from(cells)), label: label.into() }
}

pub struct FakeLedger {
    pub rows: usize,
}

impl PageSource<TableRowData> for FakeLedger {
    fn row_count(&self) -> usize {
        self.rows
    }
    fn fetch(&self, start: usize, count: usize) -> Vec<TableRowData> {
        (start..start + count).map(fake_row).collect()
    }
}

/// What `wire` gives back: keeps the model and the selection alive and lets a test look at them.
pub struct Demo {
    pub model: Rc<PagedModel<TableRowData>>,
    pub selection: Rc<RefCell<Selection>>,
}

/// Connects the `TableDemo` global of the gallery to a `rows`-row fake ledger.
pub fn wire(ui: &Gallery, rows: usize) -> Demo {
    let demo = ui.global::<TableDemo>();
    let model = Rc::new(PagedModel::new(FakeLedger { rows }));
    let selection = Rc::new(RefCell::new(Selection::default()));
    demo.set_rows(model.to_model_rc());
    let specs = [
        ColumnSpec { title: "Date".into(), width: ColumnWidth::Fixed(110.0), numeric: false },
        ColumnSpec { title: "Description".into(), width: ColumnWidth::Flex { weight: 2.0, min: 120.0 }, numeric: false },
        ColumnSpec { title: "Category".into(), width: ColumnWidth::Flex { weight: 1.0, min: 100.0 }, numeric: false },
        ColumnSpec { title: "Amount".into(), width: ColumnWidth::Fixed(120.0), numeric: true },
    ];
    let weak = ui.as_weak();
    demo.on_layout_requested(move |width| {
        if let Some(ui) = weak.upgrade() {
            ui.global::<TableDemo>().set_columns(columns_model(&specs, width));
        }
    });
    let rev = Rc::new(Cell::new(0));
    let (sel, weak, count) = (selection.clone(), ui.as_weak(), rev.clone());
    demo.on_select(move |row, shift, toggle| {
        sel.borrow_mut().apply(row as usize, Gesture::from_modifiers(shift, toggle));
        if let Some(ui) = weak.upgrade() {
            let d = ui.global::<TableDemo>();
            count.set(count.get() + 1);
            d.set_selection_rev(count.get());
            d.set_selected_count(sel.borrow().count() as i32);
            d.set_last_event(format!("select {row}{}{}", if shift { " shift" } else { "" }, if toggle { " toggle" } else { "" }).into());
        }
    });
    let (sel, weak, rows, rev) = (selection.clone(), ui.as_weak(), model.clone(), rev.clone());
    demo.on_select_all(move |on| {
        if on {
            sel.borrow_mut().select_all(rows.row_count());
        } else {
            sel.borrow_mut().clear();
        }
        if let Some(ui) = weak.upgrade() {
            let d = ui.global::<TableDemo>();
            rev.set(rev.get() + 1);
            d.set_selection_rev(rev.get());
            d.set_selected_count(sel.borrow().count() as i32);
            d.set_last_event(if on { "select-all" } else { "clear" }.into());
        }
    });
    let sel = selection.clone();
    demo.on_is_selected(move |row| sel.borrow().contains(row as usize));
    Demo { model, selection }
}
