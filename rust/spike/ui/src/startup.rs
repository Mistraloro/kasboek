//! Real window with start-up milestones in the style of startup.log, the device prompt and the typing test.
use crate::device::{self, Event, Outcome, Report};
use crate::{App, Startup, fixtures, log, strings::Locale};
use slint::ComponentHandle;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

/// The value after `name`; the last one wins, so a script can put defaults first and the owner's options after them.
fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .rposition(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

pub fn run(args: &[String]) {
    let t0 = Instant::now();
    let gap = log::ms_since_process_creation();
    let custom_log = arg(args, "--log");
    // startup.log next to the binary, the previous run kept as startup.prev.log. `--log FILE` writes just that file.
    match &custom_log {
        Some(path) => log::init(t0, gap, Some(path.into()), false),
        None => log::init(t0, gap, log::default_path(), true),
    }
    std::panic::set_hook(Box::new(|info| {
        log::mark(&format!("PANIC: {info}"));
        log::flush();
    }));
    match gap {
        Some(g) => log::mark(&format!(
            "process start (OS creation time; main entered {g:.0} ms later)"
        )),
        None => log::mark("process start (not known on this OS: times count from main)"),
    }
    log::mark("main entered");

    let screen = arg(args, "--screen").unwrap_or_else(|| "lock-password".into());
    let dark = arg(args, "--theme").as_deref() == Some("dark");
    let lang = arg(args, "--lang").unwrap_or_else(|| "en".into());
    let scale = arg(args, "--scale");
    let typing = args.iter().any(|a| a == "--typing");
    let exit = args.iter().any(|a| a == "--exit-after-first-frame");
    // Keeps the window open for N ms and then closes it (the CI step that dumps the UI Automation tree needs this).
    let exit_after_ms: Option<u64> = arg(args, "--exit-after-ms").and_then(|v| v.parse().ok());
    let renderer = arg(args, "--renderer").unwrap_or_else(|| "software".into());
    log::mark(&format!(
        "settings: os={} arch={} screen={screen} theme={} lang={lang} scale={} typing={typing}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        if dark { "dark" } else { "light" },
        scale.as_deref().unwrap_or("system"),
    ));

    if let Some(s) = &scale {
        // SAFETY: nothing else runs yet (no threads, the event loop is not created), so setting the environment is safe.
        unsafe { std::env::set_var("SLINT_SCALE_FACTOR", s) };
    }
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .renderer_name(renderer.clone())
        .select()
        .expect("backend");
    log::mark(&format!("backend selected (renderer {renderer})"));

    let en = Locale::load_lang(&lang);
    log::mark(&format!("texts read ({lang}.json)"));
    let ui = App::new().expect("ui");
    fixtures::apply(&ui, &en, &screen, dark);
    ui.global::<Startup>().set_autofocus(true);
    if device::is_touch_id() {
        fixtures::set_device(&ui, &en, true);
    }
    if typing {
        ui.set_typing(true);
        ui.set_typing_label("Type here to test accents and dead keys".into());
    }
    ui.on_device_pressed({
        let weak = ui.as_weak();
        move || press_device(&weak)
    });
    // These two links do nothing in the spike; the answer is a live text so that a screen reader says it.
    ui.on_forgot_pressed(say(&ui, "Forgot password: not part of this spike."));
    ui.on_erase_pressed(say(
        &ui,
        "Erase data: not part of this spike, nothing was erased.",
    ));
    log::mark("window created");

    // First frame: the rendering notifier (GL renderers) or, for the software renderer, the first timer tick after show().
    let first = Rc::new(RefCell::new(false));
    let notifier_ok = {
        let (first, weak) = (first.clone(), ui.as_weak());
        ui.window()
            .set_rendering_notifier(move |state, _| {
                if matches!(state, slint::RenderingState::AfterRendering) && !*first.borrow() {
                    *first.borrow_mut() = true;
                    first_frame("first frame painted");
                    if exit {
                        let _ = weak.upgrade_in_event_loop(|_| {});
                        let _ = slint::quit_event_loop();
                    }
                }
            })
            .is_ok()
    };
    ui.show().expect("show");
    log::mark("window shown (show() returned)");
    if !notifier_ok {
        log::mark("rendering notifier unsupported by this renderer");
        let weak = ui.as_weak();
        // Software renderer: this runs on the event loop after the first pass, which renders and presents.
        // The first redraw is handled before this timer fires, so this is an upper bound (+16 ms).
        slint::Timer::single_shot(std::time::Duration::from_millis(16), move || {
            first_frame(
                "first frame painted (software renderer has no hook: 16 ms timer after show, upper bound)",
            );
            let _ = weak.upgrade();
            if exit {
                let _ = slint::quit_event_loop();
            }
        });
    }
    if let Some(ms) = exit_after_ms {
        slint::Timer::single_shot(std::time::Duration::from_millis(ms), || {
            let _ = slint::quit_event_loop();
        });
    }
    slint::run_event_loop().expect("event loop");
    log::mark("event loop ended");
    log::flush();
}

/// A callback that shows `text` in the result line under the card.
fn say(ui: &App, text: &'static str) -> impl Fn() + 'static {
    let weak = ui.as_weak();
    move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_device_result(text.into());
        }
    }
}

fn first_frame(what: &str) {
    log::mark(what);
    log::mark(&format!("time-to-first-frame {:.0} ms", log::now_ms()));
    // A start that is killed or crashes later still leaves its milestones.
    slint::Timer::single_shot(std::time::Duration::from_millis(300), log::flush);
}

/// The press of the "Unlock with Windows Hello / Touch ID" button: ask the OS, log the milestones, show the answer.
fn press_device(weak: &slint::Weak<App>) {
    let pressed = Instant::now();
    log::mark("device prompt requested");
    let Some(ui) = weak.upgrade() else { return };
    ui.set_device_busy(true);
    ui.set_device_result("Waiting for the system prompt...".into());
    let name = if device::is_touch_id() {
        "Touch ID"
    } else {
        "Windows Hello"
    };
    let window = device::window_id(ui.window());
    let weak = weak.clone();
    let report: Report = Arc::new(move |event| {
        let since = pressed.elapsed().as_millis();
        match event {
            Event::Info(text) => log::mark(&format!("device: {text}")),
            Event::Shown(how) => {
                log::mark(&format!(
                    "device prompt shown ({how}), {since} ms after press"
                ));
                log::mark(&format!("time-to-prompt {since} ms"));
            }
            Event::Answered(outcome, detail) => {
                log::mark(&format!(
                    "device answered ({}), {since} ms after press: {detail}",
                    outcome.word()
                ));
                log::flush();
                let text = match outcome {
                    Outcome::Verified => {
                        format!("{name}: verified. Nothing is unlocked in this spike.")
                    }
                    other => format!("{name}: {}. {detail}", other.word()),
                };
                let weak = weak.clone();
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(ui) = weak.upgrade() {
                        ui.set_device_result(text.into());
                        ui.set_device_busy(false);
                    }
                });
            }
        }
    });
    device::request(
        window,
        "Kasboek spike: confirm that it is you (nothing is unlocked)",
        report,
    );
}
