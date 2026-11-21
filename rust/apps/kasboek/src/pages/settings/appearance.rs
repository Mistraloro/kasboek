//! Settings -> Appearance: a stub until its batch ports the section.
use crate::app::Ctl;
use crate::{App, AppearanceState};
use slint::ComponentHandle;
use std::rc::Rc;

pub fn wire(_ctl: &Rc<Ctl>, _ui: &App) {}

/// The page is opened: the text of the placeholder.
pub fn show(ctl: &Ctl, ui: &App) {
    ui.global::<AppearanceState>().set_body(super::super::not_ported_body(ctl, "settings.appearance"));
}

pub fn on_data_changed(_ctl: &Rc<Ctl>, _ui: &App) {}
