//! Settings -> Security (minimal): change password, passwordless, a new recovery key, two-factor on and off, all through the
//! `auth.*` operations. Success and failure come as toasts; what the person typed is wiped from the screen after each call.
use crate::app::{s, with, Ctl};
use crate::{App, Sec, Totp};
use serde_json::{json, Value};
use slint::{ComponentHandle, ModelRc, VecModel};
use std::rc::Rc;

impl Ctl {
    pub(crate) fn wire_security(self: &Rc<Self>, ui: &App) {
        let sec = ui.global::<Sec>();
        sec.on_opened(|| with(|c| c.refresh_security_now()));
        sec.on_password_edited(|t| with(|c| c.sec_password_edited(&t)));
        sec.on_change_password(|current, next| with(|c| c.change_password(&current, &next)));
        sec.on_use_passwordless(|current| with(|c| c.use_passwordless(&current)));
        sec.on_new_recovery_key(|current| with(|c| c.new_recovery_key(&current)));
        sec.on_totp_begin(|| {
            with(|c| {
                if let Some(ui) = c.ui.upgrade() {
                    ui.global::<Sec>().set_view(s("totp"));
                }
                c.totp_begin();
            })
        });
        sec.on_totp_disable(|code| with(|c| c.totp_disable(&code)));
        sec.on_back(|| {
            with(|c| {
                if let Some(ui) = c.ui.upgrade() {
                    ui.global::<Sec>().set_view(s("main"));
                    ui.global::<Totp>().set_secret(s(""));
                }
            })
        });
    }

    fn refresh_security_now(self: &Rc<Self>) {
        if let Some(ui) = self.ui.upgrade() {
            self.refresh_security(&ui);
        }
    }

    /// Reads the status and shows what the page needs of it: how the account is opened, 2FA, the key protection.
    pub(crate) fn refresh_security(&self, _ui: &App) {
        self.run("auth.status", json!({}), |c, ui, res| {
            if let Ok(st) = res {
                c.show_security(ui, &st);
            }
        });
    }

    /// What the page needs of the status: how the account is opened, 2FA, the key protection, the device.
    pub fn show_security(&self, ui: &App, st: &Value) {
        let sec = ui.global::<Sec>();
        let device = st["mode"] == "device";
        let kind = st["device"].as_str().unwrap_or("");
        let os_ok = st["keyProtection"].as_str().unwrap_or("os") == "os";
        sec.set_mode(s(if device { "device" } else { "password" }));
        sec.set_two_factor(st["twoFactor"].as_bool().unwrap_or(false));
        // A password is asked for the changes unless the account has none, or was just opened with the recovery key.
        sec.set_need_current(!device && !st["recovered"].as_bool().unwrap_or(false));
        sec.set_key_storage(s(self.cat.t(if os_ok { "settings.keyStorageOs" } else { "settings.keyStorageWeak" })));
        let name = if kind.is_empty() { String::new() } else { self.device_name(kind) };
        sec.set_device_title(s(if kind.is_empty() {
            self.cat.t("auth.choosePasswordless")
        } else {
            self.cat.tv("auth.chooseDevice", &[("name", &name)])
        }));
        sec.set_device_enabled(!kind.is_empty() && os_ok);
        sec.set_device_note(s(if kind.is_empty() {
            self.cat.t("auth.deviceUnavailableHint")
        } else if !os_ok {
            self.cat.t("auth.deviceUnprotectedHint")
        } else {
            String::new()
        }));
        if sec.get_next_a().is_empty() {
            let (strength, word, rules) = self.strength_view("");
            sec.set_strength(strength);
            sec.set_strength_text(word);
            sec.set_rules(ModelRc::new(VecModel::from(rules)));
        }
    }

    fn sec_password_edited(&self, text: &str) {
        let Some(ui) = self.ui.upgrade() else { return };
        let (strength, word, rules) = self.strength_view(text);
        let sec = ui.global::<Sec>();
        sec.set_strength(strength);
        sec.set_strength_text(word);
        sec.set_rules(ModelRc::new(VecModel::from(rules)));
    }

    /// What was typed on the page is dropped: after a call, and when the app locks.
    pub(crate) fn clear_security(&self, ui: &App) {
        let sec = ui.global::<Sec>();
        wipe_fields(&sec);
        sec.set_view(s("main"));
        sec.set_busy(false);
        let (strength, word, rules) = self.strength_view("");
        sec.set_strength(strength);
        sec.set_strength_text(word);
        sec.set_rules(ModelRc::new(VecModel::from(rules)));
        let totp = ui.global::<Totp>();
        totp.set_secret(s(""));
        totp.set_code(s(""));
    }

    /// Runs one of the changes: the current password goes along only when the page asked for it.
    fn change(
        self: &Rc<Self>,
        op: &'static str,
        input: Value,
        done: &'static str,
        then: impl FnOnce(&Rc<Ctl>, &App, Value) + Send + 'static,
    ) {
        let Some(ui) = self.ui.upgrade() else { return };
        ui.global::<Sec>().set_busy(true);
        self.run(op, input, move |c, ui, res| {
            let sec = ui.global::<Sec>();
            sec.set_busy(false);
            match res {
                Ok(r) => {
                    wipe_fields(&sec);
                    if !done.is_empty() {
                        c.toast("info", c.cat.t(done));
                    }
                    then(c, ui, r);
                    c.refresh_security(ui);
                }
                Err(e) => c.toast("error", c.err_text(&e)),
            }
        });
    }

    fn current_input(&self, current: &str) -> Value {
        let need = self.ui.upgrade().is_some_and(|ui| ui.global::<Sec>().get_need_current());
        if need {
            json!({ "current": current })
        } else {
            json!({})
        }
    }

    fn change_password(self: &Rc<Self>, current: &str, next: &str) {
        let mut input = self.current_input(current);
        input["next"] = json!(next);
        self.change("auth.changePassword", input, "auth.passwordChanged", |_, _, _| {});
    }

    fn use_passwordless(self: &Rc<Self>, current: &str) {
        let input = self.current_input(current);
        self.change("auth.usePasswordless", input, "settings.passwordlessOn", |_, _, _| {});
    }

    fn new_recovery_key(self: &Rc<Self>, current: &str) {
        let input = self.current_input(current);
        self.change("auth.newRecoveryKey", input, "", |c, ui, r| {
            c.show_recovery(ui, r["recoveryKey"].as_str().unwrap_or(""));
            ui.global::<Sec>().set_view(s("recovery"));
        });
    }

    fn totp_disable(self: &Rc<Self>, code: &str) {
        self.change("auth.totpDisable", json!({ "code": code }), "settings.twoFactorDisabled", |_, _, _| {});
    }
}

fn wipe_fields(sec: &Sec<'_>) {
    sec.set_current(s(""));
    sec.set_next_a(s(""));
    sec.set_next_b(s(""));
    sec.set_off_code(s(""));
}
