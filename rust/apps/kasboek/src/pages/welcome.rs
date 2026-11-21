//! The welcome screen with the tour: a stub until batch P9 ports it. No start path leads here yet (screenshots only).
use crate::app::Ctl;
use crate::{App, WelcomeState};
use slint::ComponentHandle;
use std::rc::Rc;

pub fn wire(_ctl: &Rc<Ctl>, _ui: &App) {}

/// The screen is set up: the texts of the placeholder.
pub fn show(ctl: &Ctl, ui: &App) {
    let state = ui.global::<WelcomeState>();
    state.set_heading(super::not_ported_heading(ctl));
    state.set_body(super::not_ported_body(ctl, "app.name"));
}

pub fn on_data_changed(_ctl: &Rc<Ctl>, _ui: &App) {}
