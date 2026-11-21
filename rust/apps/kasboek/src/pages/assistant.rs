//! The assistant panel: a stub until batch P8 ports it.
use crate::app::{s, Ctl};
use crate::{App, AssistantPanelState};
use slint::ComponentHandle;
use std::rc::Rc;

pub fn wire(_ctl: &Rc<Ctl>, _ui: &App) {}

/// The panel is set up: its text.
pub fn show(ctl: &Ctl, ui: &App) {
    ui.global::<AssistantPanelState>().set_note(s(ctl.cat.t("native.assistantNote")));
}

pub fn on_data_changed(_ctl: &Rc<Ctl>, _ui: &App) {}
