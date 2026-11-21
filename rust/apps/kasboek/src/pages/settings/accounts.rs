//! Settings -> Accounts: a stub until batch P2 ports the section (it replaces the developer preview of the Accounts page).
use crate::app::Ctl;
use crate::{AccountsState, App};
use slint::ComponentHandle;
use std::rc::Rc;

pub fn wire(_ctl: &Rc<Ctl>, _ui: &App) {}

/// The page is opened: the text of the placeholder.
pub fn show(ctl: &Ctl, ui: &App) {
    ui.global::<AccountsState>().set_body(super::super::not_ported_body(ctl, "settings.accounts"));
}

pub fn on_data_changed(_ctl: &Rc<Ctl>, _ui: &App) {}

/// An amount as typed ("12", "-12.50", "12,5") in cents. No thousands separators, at most two decimals. Kept from the
/// developer preview for the AmountInput of U1, which takes it over (the plan moves it from here).
#[allow(dead_code)]
pub fn parse_cents(text: &str) -> Option<i64> {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = digits.split_once(['.', ',']).unwrap_or((digits, ""));
    let plain = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() && fraction.is_empty() || !plain(whole) || !plain(fraction) || fraction.len() > 2 || whole.len() > 12 {
        return None;
    }
    let cents = whole.parse::<i64>().unwrap_or(0) * 100 + format!("{fraction:0<2}").parse::<i64>().ok()?;
    Some(if negative { -cents } else { cents })
}

#[cfg(test)]
mod tests {
    use super::parse_cents;

    #[test]
    fn amounts_as_typed() {
        assert_eq!(parse_cents("12"), Some(1200));
        assert_eq!(parse_cents("-12.50"), Some(-1250));
        assert_eq!(parse_cents("12,5"), Some(1250));
        assert_eq!(parse_cents(" +0.07 "), Some(7));
        assert_eq!(parse_cents(".5"), Some(50));
        assert_eq!(parse_cents("1.234"), None);
        assert_eq!(parse_cents("1,000.00"), None);
        assert_eq!(parse_cents("-"), None);
        assert_eq!(parse_cents(""), None);
        assert_eq!(parse_cents("abc"), None);
    }
}
