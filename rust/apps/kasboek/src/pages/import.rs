//! Import: a stub until batch P4 ports the page.
use crate::app::Ctl;
use crate::{App, ImportState};
use slint::ComponentHandle;
use std::rc::Rc;

pub fn wire(_ctl: &Rc<Ctl>, _ui: &App) {}

/// The page is opened: the texts of the placeholder.
pub fn show(ctl: &Ctl, ui: &App) {
    let state = ui.global::<ImportState>();
    state.set_heading(super::not_ported_heading(ctl));
    state.set_body(super::not_ported_body(ctl, "nav.import"));
}

pub fn on_data_changed(_ctl: &Rc<Ctl>, _ui: &App) {}
