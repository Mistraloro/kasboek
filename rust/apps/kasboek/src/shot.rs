//! Offscreen screenshots of the screens (software renderer, no windowing system): `kasboek shot <screen> <light|dark> out.png`.
//! The same controller and data as the real window; the screens are put in place synchronously.
use crate::{app, arg, flag, pick_service, prefs::Prefs, service_from, today_from, view, App, DateCheck, Kind, Lock, Rules, SetupState};
use kb_service::LoadStep;
use kb_ui::shot;
use serde_json::json;
use slint::ComponentHandle;
use std::path::PathBuf;

fn point(text: &str) -> (f32, f32) {
    let (x, y) = text.split_once(',').unwrap_or(("0", "0"));
    (x.trim().parse().unwrap_or(0.0), y.trim().parse().unwrap_or(0.0))
}

pub fn run(args: &[String]) -> i32 {
    let positional: Vec<&String> = args
        .iter()
        .skip(1)
        .enumerate()
        .filter(|(i, a)| {
            !a.starts_with("--")
                && !(*i > 0
                    && matches!(
                        args[*i].as_str(),
                        "--scale"
                            | "--width"
                            | "--height"
                            | "--tab"
                            | "--keys"
                            | "--hold"
                            | "--hover"
                            | "--lang"
                            | "--inset"
                            | "--today"
                            | "--password"
                            | "--page"
                    ))
        })
        .map(|(_, a)| a)
        .collect();
    let [screen, theme, out, ..] = positional.as_slice() else {
        eprintln!("usage: kasboek shot <screen> <light|dark> <out.png> [--scale 2] [--width 1440] [--height 900] [--tab N] [--keys K,K] [--hold X,Y] [--hover X,Y] [--lang en] [--inset 148] [--today 2026-11-15] [--password TEXT] [--page NAME]");
        return 2;
    };
    let num = |name: &str, default: f32| arg(args, name).and_then(|v| v.parse().ok()).unwrap_or(default);
    let (width, height, scale) = (num("--width", 1440.0) as u32, num("--height", 900.0) as u32, num("--scale", 2.0));
    let window = shot::install();
    let ui = App::new().expect("ui");
    kb_ui::wire_rules!(&ui);
    let mut service_args = args.to_vec();
    if screen.as_str() == "overview" || screen.as_str() == "loading" {
        service_args.extend(["--state".into(), "unlocked".into()]);
    }
    // These screens need the answers of the real core (a seeded temporary database).
    if matches!(screen.as_str(), "setup-twofactor" | "security" | "accounts") {
        service_args.extend(["--service".into(), "core-temp".into(), "--state".into(), "unlocked".into()]);
    }
    if screen.starts_with("lock-device") {
        service_args.extend(["--mode".into(), "device".into(), "--device".into(), "windows-hello".into()]);
    }
    // The screens are drawn from the fixtures unless a real service is asked for.
    let kind = pick_service(&service_args, false, false).unwrap_or(Kind::Fixture);
    let service = match service_from(&service_args, kind, &std::env::temp_dir().join("kasboek-shot"), Default::default()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let mut prefs = Prefs { theme: theme.to_string(), language: arg(args, "--lang").unwrap_or_else(|| "en".into()), ..Prefs::default() };
    prefs.last_auth = None;
    let today = arg(args, "--today").map_or((2026, 11, 15), |_| today_from(args));
    let cfg = app::Config {
        data_dir: std::env::temp_dir().join("kasboek-shot"),
        today,
        #[cfg(feature = "dev-start")]
        fake_device: false,
        caption_inset: num("--inset", 148.0),
        device_in_service: false,
    };
    let ctl = app::Ctl::attach(&ui, service.clone(), cfg, &prefs);
    ctl.set_theme(&ui, theme.as_str() == "dark");

    let status = |mode: &str, device: Option<&str>| json!({ "state": "locked", "mode": mode, "device": device, "twoFactor": false, "rememberedUntil": null, "throttleSeconds": 0, "keyProtection": "os", "deviceChecking": false, "legacyData": false });
    match screen.as_str() {
        "lock-password" => ctl.show_lock(&ui, &status("password", None)),
        "lock-device" => ctl.show_lock(&ui, &status("device", Some("windows-hello"))),
        "lock-error" => {
            ctl.show_lock(&ui, &status("password", None));
            let lock = ui.global::<Lock>();
            lock.set_error("That password is wrong.".into());
            lock.set_throttle("Too many attempts. Wait 10 seconds.".into());
        }
        "lock-busy" => {
            ctl.show_lock(&ui, &status("password", None));
            let lock = ui.global::<Lock>();
            lock.set_busy(true);
            lock.set_password("correct horse battery 12".into());
        }
        "setup" | "setup-password" | "setup-recovery" => {
            ctl.show_setup(&ui, &json!({ "device": "windows-hello", "keyProtection": "os", "deviceChecking": false, "legacyData": false }));
            let setup = ui.global::<SetupState>();
            if screen.as_str() != "setup" {
                setup.set_step("password".into());
                let pw = arg(args, "--password").unwrap_or_else(|| "kraan-tulp-Ober-7-fiets".into());
                setup.set_password_a(pw.clone().into());
                setup.set_password_b(pw.clone().into());
                ctl.password_edited(&pw);
            }
            if screen.as_str() == "setup-recovery" {
                ctl.show_recovery(&ui, "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789");
                setup.set_step("recovery".into());
            }
        }
        "setup-twofactor" => {
            ctl.show_setup(&ui, &json!({ "device": "windows-hello", "keyProtection": "os", "deviceChecking": false, "legacyData": false }));
            ui.global::<SetupState>().set_step("twofactor".into());
            ctl.show_totp(&ui, kb_service::block_on(service.invoke("auth.totpBegin", json!({}))));
        }
        "security" | "accounts" => {
            let call = |op: &str| kb_service::block_on(service.invoke(op, json!({})));
            ctl.show_security(&ui, &call("auth.status").unwrap_or_default());
            ctl.show_accounts(&ui, &call("accounts.list"));
            ui.global::<crate::ShellState>().set_page(screen.as_str().replace("security", "settings").into());
            ui.set_screen("shell".into());
        }
        "loading" => {
            ctl.progress(&ui, LoadStep::Opening, 1, 1);
            ctl.progress(&ui, LoadStep::Transactions, 3, 4);
            ui.set_screen("loading".into());
        }
        "overview" => {
            let data = view::fetch(service.as_ref(), today.0, today.1, &mut |_, _, _| {});
            ctl.show_overview(&ui, data, flag(args, "--all-tips"));
            if let Some(page) = arg(args, "--page") {
                ui.global::<crate::ShellState>().set_page(page.into());
            }
            ui.set_screen("shell".into());
        }
        other => {
            eprintln!("unknown screen {other:?}");
            return 2;
        }
    }
    shot::open(&window, &ui, width, height, scale);
    for _ in 0..arg(args, "--tab").and_then(|n| n.parse().ok()).unwrap_or(0) {
        shot::press(&window, "Tab");
    }
    for key in arg(args, "--keys").iter().flat_map(|k| k.split(',')) {
        shot::press(&window, key.trim());
    }
    if let Some(p) = arg(args, "--hover") {
        let (x, y) = point(&p);
        shot::hover(&window, x, y);
    }
    if let Some(p) = arg(args, "--hold") {
        let (x, y) = point(&p);
        shot::mouse_down(&window, x, y);
    }
    shot::write_png(&window, &PathBuf::from(out.as_str()));
    0
}
