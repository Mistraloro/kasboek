//! The Accounts page of the developer preview: add an account and a transaction through `accounts.create` and
//! `transactions.create`, so that the Overview shows real numbers. Temporary: the real Accounts and Transactions pages replace it.
use crate::app::{s, with, Ctl};
use crate::view::Res;
use crate::{Acc, AccountLine, App};
use serde_json::{json, Value};
use slint::{ComponentHandle, ModelRc, VecModel};
use std::rc::Rc;

/// An amount as typed ("12", "-12.50", "12,5") in cents. No thousands separators, at most two decimals.
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

impl Ctl {
    pub(crate) fn wire_accounts(self: &Rc<Self>, ui: &App) {
        let acc = ui.global::<Acc>();
        acc.on_opened(|| {
            with(|c| {
                if let Some(ui) = c.ui.upgrade() {
                    let acc = ui.global::<Acc>();
                    if acc.get_date().is_empty() {
                        let (y, m, d) = c.cfg.today;
                        acc.set_date(s(format!("{y:04}-{m:02}-{d:02}")));
                    }
                    c.refresh_accounts();
                }
            })
        });
        acc.on_add_account(|name, opening| with(|c| c.add_account(&name, &opening)));
        acc.on_add_transaction(|index, date, description, amount| with(|c| c.add_transaction(index, &date, &description, &amount)));
    }

    pub(crate) fn refresh_accounts(&self) {
        self.run("accounts.list", json!({}), |c, ui, res| c.show_accounts(ui, &res));
    }

    /// The accounts the page lists, from an `accounts.list` answer.
    pub fn show_accounts(&self, ui: &App, res: &Res) {
        let acc = ui.global::<Acc>();
        let fmt = self.fmt.borrow();
        let rows: Vec<AccountLine> = res
            .iter()
            .flat_map(|list| list.as_array().into_iter().flatten())
            .filter(|a| !a["archived"].as_bool().unwrap_or(false))
            .map(|a| AccountLine {
                id: a["id"].as_i64().unwrap_or(0) as i32,
                name: a["name"].as_str().unwrap_or("").into(),
                balance: fmt.money(a["balanceCents"].as_i64().unwrap_or(0), a["currency"].as_str().unwrap_or("EUR")).into(),
            })
            .collect();
        if usize::try_from(acc.get_selected()).map_or(true, |i| i >= rows.len()) {
            acc.set_selected(0);
        }
        acc.set_rows(ModelRc::new(VecModel::from(rows)));
    }

    /// Runs a write of this page; a failure is a toast, a success clears what was typed.
    fn write(self: &Rc<Self>, op: &'static str, input: Value, clear: fn(&Acc<'_>)) {
        let Some(ui) = self.ui.upgrade() else { return };
        ui.global::<Acc>().set_busy(true);
        self.run(op, input, move |c, ui, res| {
            let acc = ui.global::<Acc>();
            acc.set_busy(false);
            match res {
                Ok(_) => {
                    clear(&acc);
                    c.toast("info", c.cat.t("native.saved"));
                    c.refresh_accounts();
                }
                Err(e) => c.toast("error", c.err_text(&e)),
            }
        });
    }

    fn add_account(self: &Rc<Self>, name: &str, opening: &str) {
        let Some(cents) = (if opening.trim().is_empty() { Some(0) } else { parse_cents(opening) }) else {
            return self.toast("error", self.cat.t("native.badAmount"));
        };
        let input = json!({ "name": name, "kind": "current", "currency": "EUR", "openingBalanceCents": cents });
        self.write("accounts.create", input, |acc| {
            acc.set_name(s(""));
            acc.set_opening(s(""));
        });
    }

    fn add_transaction(self: &Rc<Self>, index: i32, date: &str, description: &str, amount: &str) {
        let Some(ui) = self.ui.upgrade() else { return };
        let Some(cents) = parse_cents(amount).filter(|c| *c != 0) else {
            ui.global::<Acc>().set_error(s(self.cat.t("native.badAmount")));
            return;
        };
        ui.global::<Acc>().set_error(s(""));
        let rows = ui.global::<Acc>().get_rows();
        let Some(account) = usize::try_from(index).ok().and_then(|i| slint::Model::row_data(&rows, i)) else { return };
        self.write(
            "transactions.create",
            json!({ "accountId": account.id, "bookingDate": date, "amountCents": cents, "description": description }),
            |acc| {
                acc.set_description(s(""));
                acc.set_amount(s(""));
            },
        );
    }
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
