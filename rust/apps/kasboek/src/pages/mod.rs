//! The pages. Each page has a file here (settings sections in `settings/`) with `wire()` (connect its callbacks once),
//! `show()` (the page is opened: set what it displays) and `on_data_changed()` (the data of the book changed while it is open),
//! and its own global in its .slint file (`ui/pages/`). `app.rs` only calls `wire_all`, `show`, `on_data_changed` and `on_lock`;
//! a page batch edits its own files and nothing here, except the `match` arms of a page that is new.
use crate::app::{s, Ctl};
use crate::App;
use slint::SharedString;
use std::rc::Rc;

pub mod assistant;
pub mod budgets;
pub mod goals;
pub mod import;
pub mod networth;
pub mod recurring;
pub mod settings;
pub mod transactions;
pub mod welcome;
pub mod year;

/// Connects the callbacks of every page (once, at start).
pub fn wire_all(ctl: &Rc<Ctl>, ui: &App) {
    transactions::wire(ctl, ui);
    budgets::wire(ctl, ui);
    recurring::wire(ctl, ui);
    goals::wire(ctl, ui);
    year::wire(ctl, ui);
    networth::wire(ctl, ui);
    import::wire(ctl, ui);
    settings::wire(ctl, ui);
    assistant::wire(ctl, ui);
    welcome::wire(ctl, ui);
}

/// A page is opened (`ShellState.page` names it; "assistant" and "welcome" are the panel and the welcome screen). The
/// Overview is not one of these yet; unknown names do nothing.
pub fn show(ctl: &Ctl, ui: &App, page: &str) {
    match page {
        "transactions" => transactions::show(ctl, ui),
        "budgets" => budgets::show(ctl, ui),
        "recurring" => recurring::show(ctl, ui),
        "goals" => goals::show(ctl, ui),
        "year" => year::show(ctl, ui),
        "networth" => networth::show(ctl, ui),
        "import" => import::show(ctl, ui),
        "settings" => settings::show(ctl, ui),
        "assistant" => assistant::show(ctl, ui),
        "welcome" => welcome::show(ctl, ui),
        _ => {}
    }
}

/// The data of the book changed (an operation wrote, a restore, a sync): every page refreshes what it shows.
pub fn on_data_changed(ctl: &Rc<Ctl>, ui: &App) {
    transactions::on_data_changed(ctl, ui);
    budgets::on_data_changed(ctl, ui);
    recurring::on_data_changed(ctl, ui);
    goals::on_data_changed(ctl, ui);
    year::on_data_changed(ctl, ui);
    networth::on_data_changed(ctl, ui);
    import::on_data_changed(ctl, ui);
    settings::on_data_changed(ctl, ui);
    assistant::on_data_changed(ctl, ui);
    welcome::on_data_changed(ctl, ui);
}

/// The app locks: what a page holds of the session (typed secrets, data) is dropped.
pub fn on_lock(ctl: &Ctl, ui: &App) {
    settings::on_lock(ctl, ui);
}

/// The heading of the placeholder of a page that is not ported yet.
pub(crate) fn not_ported_heading(ctl: &Ctl) -> SharedString {
    s(ctl.cat.t("native.notPortedTitle"))
}

/// The text of the placeholder of a page or section that is not ported yet; `title_key` is the locale key of its name.
pub(crate) fn not_ported_body(ctl: &Ctl, title_key: &str) -> SharedString {
    s(ctl.cat.tv("native.notPortedBody", &[("page", &ctl.cat.t(title_key))]))
}
