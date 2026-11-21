//! The Settings page: its sections, one file each. The tab shown is `SettingsState.tab` (pages.slint).
use crate::app::Ctl;
use crate::App;
use std::rc::Rc;

pub mod about;
pub mod accounts;
pub mod appearance;
pub mod assistant;
pub mod backups;
pub mod currencies;
pub mod formats;
pub mod insights;
pub mod memory;
pub mod security;
pub mod sync;
pub mod transfer;

pub fn wire(ctl: &Rc<Ctl>, ui: &App) {
    appearance::wire(ctl, ui);
    formats::wire(ctl, ui);
    currencies::wire(ctl, ui);
    insights::wire(ctl, ui);
    accounts::wire(ctl, ui);
    security::wire(ctl, ui);
    backups::wire(ctl, ui);
    sync::wire(ctl, ui);
    transfer::wire(ctl, ui);
    assistant::wire(ctl, ui);
    memory::wire(ctl, ui);
    about::wire(ctl, ui);
}

pub fn show(ctl: &Ctl, ui: &App) {
    appearance::show(ctl, ui);
    formats::show(ctl, ui);
    currencies::show(ctl, ui);
    insights::show(ctl, ui);
    accounts::show(ctl, ui);
    security::show(ctl, ui);
    backups::show(ctl, ui);
    sync::show(ctl, ui);
    transfer::show(ctl, ui);
    assistant::show(ctl, ui);
    memory::show(ctl, ui);
    about::show(ctl, ui);
}

pub fn on_data_changed(ctl: &Rc<Ctl>, ui: &App) {
    appearance::on_data_changed(ctl, ui);
    formats::on_data_changed(ctl, ui);
    currencies::on_data_changed(ctl, ui);
    insights::on_data_changed(ctl, ui);
    accounts::on_data_changed(ctl, ui);
    security::on_data_changed(ctl, ui);
    backups::on_data_changed(ctl, ui);
    sync::on_data_changed(ctl, ui);
    transfer::on_data_changed(ctl, ui);
    assistant::on_data_changed(ctl, ui);
    memory::on_data_changed(ctl, ui);
    about::on_data_changed(ctl, ui);
}

pub fn on_lock(ctl: &Ctl, ui: &App) {
    security::on_lock(ctl, ui);
}
