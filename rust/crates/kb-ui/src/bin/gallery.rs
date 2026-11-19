//! Component gallery of the Kasboek design system.
//!
//!   kb-ui-gallery [--case NAME] [--theme light|dark] [--scale N] [--open modal] [--exit-after-ms N]   real window
//!   kb-ui-gallery --shot CASE light|dark OUT.png [--scale N] [--tab N] [--keys "Tab,Down,Space"]
//!                 [--hover X,Y] [--hold X,Y]                                                       offscreen PNG
//!   kb-ui-gallery --list-cases
//!
//! CASE is `all` or a name of tools/cases.json (the sizes of the cases come from there). `--tab N` presses Tab N times
//! before the shot (the focus ring shows where the focus is), `--keys` presses the listed keys, `--hover` moves the
//! pointer, `--hold` presses the pointer button and keeps it down.
// A double-clicked Windows binary must not open a console window.
#![cfg_attr(windows, windows_subsystem = "windows")]
use kb_ui::{shot, DateCheck, Gallery, Rules, ToastItem};
use slint::{ComponentHandle, Model, ModelRc, VecModel};
use std::path::PathBuf;
use std::rc::Rc;

const CASES: &str = include_str!("../../tools/cases.json");

fn case_size(name: &str) -> (u32, u32) {
    if name == "all" {
        return (760, 820);
    }
    let cases: serde_json::Value = serde_json::from_str(CASES).expect("tools/cases.json");
    let case = cases.as_array().and_then(|l| l.iter().find(|c| c["name"] == name)).unwrap_or_else(|| {
        eprintln!("unknown case {name:?}; try --list-cases");
        std::process::exit(2)
    });
    (case["width"].as_u64().unwrap_or(640) as u32, case["height"].as_u64().unwrap_or(480) as u32)
}

fn opt<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn point(text: &str) -> (f32, f32) {
    let (x, y) = text.split_once(',').unwrap_or_else(|| {
        eprintln!("expected X,Y, got {text:?}");
        std::process::exit(2)
    });
    (x.trim().parse().unwrap_or(0.0), y.trim().parse().unwrap_or(0.0))
}

/// Connects the gallery's toast buttons to a model, as an app does.
fn wire(ui: &Gallery) -> Rc<VecModel<ToastItem>> {
    kb_ui::wire_rules!(ui);
    let toasts = Rc::new(VecModel::<ToastItem>::default());
    ui.set_toasts(ModelRc::from(toasts.clone()));
    let next = std::cell::Cell::new(1);
    let model = toasts.clone();
    ui.on_push_toast(move || {
        let id = next.get();
        next.set(id + 1);
        let (tone, message) =
            if id % 2 == 0 { ("error", "The backup could not be written.") } else { ("success", "Copied to the clipboard.") };
        model.push(ToastItem { id, tone: tone.into(), message: message.into() });
    });
    let model = toasts.clone();
    ui.on_dismiss_toast(move |id| {
        if let Some(i) = model.iter().position(|t| t.id == id) {
            model.remove(i);
        }
    });
    toasts
}

fn shot_mode(args: &[String]) {
    let i = args.iter().position(|a| a == "--shot").unwrap_or(0);
    let (Some(case), Some(theme), Some(out)) = (args.get(i + 1), args.get(i + 2), args.get(i + 3)) else {
        eprintln!("usage: kb-ui-gallery --shot CASE light|dark OUT.png [--scale N] [--tab N] [--keys K,K] [--hover X,Y] [--hold X,Y]");
        std::process::exit(2);
    };
    let scale: f32 = opt(args, "--scale").and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let (w, h) = case_size(case);
    let window = shot::install();
    let ui = Gallery::new().expect("ui");
    let _toasts = wire(&ui);
    ui.set_dark(theme == "dark");
    ui.set_case(case.into());
    shot::open(&window, &ui, w, h, scale);
    for _ in 0..opt(args, "--tab").and_then(|n| n.parse().ok()).unwrap_or(0) {
        shot::press(&window, "Tab");
    }
    for key in opt(args, "--keys").into_iter().flat_map(|k| k.split(',')) {
        shot::press(&window, key.trim());
    }
    if let Some(p) = opt(args, "--hover") {
        let (x, y) = point(p);
        shot::hover(&window, x, y);
    }
    if let Some(p) = opt(args, "--hold") {
        let (x, y) = point(p);
        shot::mouse_down(&window, x, y);
    }
    shot::write_png(&window, &PathBuf::from(out));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--list-cases") {
        let cases: serde_json::Value = serde_json::from_str(CASES).expect("tools/cases.json");
        for c in cases.as_array().into_iter().flatten() {
            println!("{}", c["name"].as_str().unwrap_or_default());
        }
        return;
    }
    if args.iter().any(|a| a == "--shot") {
        shot_mode(&args);
        return;
    }
    let ui = Gallery::new().expect("ui");
    let _toasts = wire(&ui);
    ui.set_dark(opt(&args, "--theme") == Some("dark"));
    let case = opt(&args, "--case").unwrap_or("all");
    ui.set_case(case.into());
    let (w, h) = case_size(case);
    ui.window().set_size(slint::LogicalSize::new(w as f32, h as f32));
    if opt(&args, "--open") == Some("modal") {
        ui.set_modal_open(true);
    }
    if let Some(ms) = opt(&args, "--exit-after-ms").and_then(|n| n.parse::<u64>().ok()) {
        // Keeps the window open for UI Automation / AT-SPI readers, then closes it.
        slint::Timer::single_shot(std::time::Duration::from_millis(ms), || {
            let _ = slint::quit_event_loop();
        });
    }
    ui.run().expect("run");
}
