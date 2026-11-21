//! Kasboek, the native app (first screens: Lock, Setup, loading view, Overview).
//!
//!   kasboek [--service core|fixture|core-temp] [--state locked|setup|unlocked] [--mode password|device] [--device windows-hello|touch-id]
//!           [--theme light|dark|system] [--lang en|nl|...] [--scale N] [--today YYYY-MM-DD] [--data-dir DIR] [--log FILE]
//!           [--slow-steps MS] [--exit-after-ms N] [--exit-after-first-frame] [--renderer software|femtovg|skia]
//!   kasboek shot <screen> <light|dark> <out.png> [--scale 2] [--width 1440] [--height 900] [--tab N] [--keys K,K] [--numbers] [--inset 148]
//!           screens: lock-password, lock-device, lock-error, lock-busy, setup, setup-password, setup-recovery, loading, overview
//!
//! The real service (`core`: kb-session + kb-core on a data folder, sealed by the operating system) runs when a data folder
//! is given (`--data-dir`, `KASBOEK_DATA_DIR`) or when the data folder of the Electron app exists and the operating system
//! can seal the account file (an Electron-sealed `account.json` is then moved to the native seal, the original kept as
//! `account.electron.json`). If that folder exists but the key store is not available, the app says so and stops. Otherwise,
//! and with any of the fixture flags (`--state`, `--mode`, `--device`, `--slow-steps`), the fixture service answers (the
//! invented household; the password is `correct horse battery 12`). `core-temp` is the real core on a seeded temporary
//! database (screens and tests).
//! A build with the cargo feature `dev-start` also knows `--fake-device` (the device prompt answers "verified") and
//! `--demo-setup` (create or unlock the account with `KASBOEK_DEMO_PASSWORD`, no screens); release builds do not.
// A double-clicked Windows binary must not open a console window; its output is startup.log.
#![cfg_attr(windows, windows_subsystem = "windows")]
mod app;
mod device;
mod format;
mod loading;
mod log;
mod pages;
mod prefs;
mod setup_rules;
mod shot;
mod titlebar;
mod view;

slint::include_modules!();

use kb_service::{AppService, CoreOptions, CoreService, FixtureConfig, FixtureService};
#[cfg(feature = "dev-start")]
use kb_session::device::{DeviceKind, FakeDevice};
use slint::ComponentHandle;
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The value after `name`; the last one wins.
pub fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().rposition(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

pub fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// Which service answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// kb-session and kb-core on the data folder.
    Core,
    /// kb-core on a seeded temporary database (screens, tests).
    CoreTemp,
    Fixture,
}

/// The fixture-only flags: whoever gives one wants the fixtures.
const FIXTURE_FLAGS: [&str; 4] = ["--state", "--mode", "--device", "--slow-steps"];

/// `--service` says; else the real service when a data folder is given (`--data-dir`, or the variable: `env_dir`) or the
/// folder of the Electron app can be opened (`default_dir_ready`: it exists and the system can seal its account file), else
/// the fixtures.
pub fn pick_service(args: &[String], env_dir: bool, default_dir_ready: bool) -> Result<Kind, String> {
    match arg(args, "--service").as_deref() {
        Some("core") => Ok(Kind::Core),
        Some("core-temp") => Ok(Kind::CoreTemp),
        Some("fixture") => Ok(Kind::Fixture),
        Some(other) => Err(format!("unknown service {other:?}")),
        None if FIXTURE_FLAGS.iter().any(|f| flag(args, f)) => Ok(Kind::Fixture),
        None if arg(args, "--data-dir").is_some() || env_dir || default_dir_ready => Ok(Kind::Core),
        None => Ok(Kind::Fixture),
    }
}

/// The service the screens talk to. `window` is where the window's handle is put once it exists (for the Hello prompt).
pub fn service_from(
    args: &[String],
    kind: Kind,
    data_dir: &Path,
    window: Arc<Mutex<Option<isize>>>,
) -> Result<Arc<dyn AppService>, String> {
    let ms = |name: &str| arg(args, name).and_then(|v| v.parse::<u64>().ok()).map(Duration::from_millis);
    match kind {
        Kind::Core => {
            let mut options = CoreOptions::native(data_dir.to_path_buf());
            options.device = Box::new(device::SessionDevice::new(window));
            #[cfg(feature = "dev-start")]
            if flag(args, "--fake-device") {
                let kind = if cfg!(target_os = "macos") { DeviceKind::TouchId } else { DeviceKind::WindowsHello };
                options.device = Box::new(FakeDevice::new(Some(kind), true));
            }
            Ok(Arc::new(CoreService::open(options).map_err(|e| e.to_string())?))
        }
        Kind::CoreTemp => {
            let svc = CoreService::temporary(arg(args, "--state").as_deref() == Some("unlocked")).map_err(|e| e.to_string())?;
            Ok(Arc::new(svc))
        }
        Kind::Fixture => {
            let mut config = FixtureConfig {
                state: arg(args, "--state").unwrap_or_else(|| "locked".into()),
                mode: arg(args, "--mode").unwrap_or_else(|| "password".into()),
                device: arg(args, "--device"),
                ..FixtureConfig::default()
            };
            if config.mode == "device" && config.device.is_none() {
                config.device = Some(if cfg!(target_os = "macos") { "touch-id" } else { "windows-hello" }.into());
            }
            if let Some(d) = ms("--slow-steps") {
                config.step_delay = d;
            }
            Ok(Arc::new(FixtureService::bundled(config)))
        }
    }
}

pub fn today_from(args: &[String]) -> (i32, u32, u32) {
    arg(args, "--today")
        .and_then(|t| {
            let mut p = t.split('-').map(|n| n.parse::<u32>().ok());
            Some((p.next()?? as i32, p.next()??, p.next()??))
        })
        .unwrap_or_else(format::today_utc)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("shot") {
        std::process::exit(shot::run(&args));
    }
    run(&args);
}

const NO_KEY_STORE: &str = "Kasboek found the data folder of the Electron app, but the key store of the operating system is not available (on Linux: no Secret Service such as GNOME Keyring or KWallet running), so the data was not opened and nothing was changed. Start the key store, or give another folder with --data-dir.";

/// A start that can't go on: said on stderr and in the log (a Windows build has no console), exit code 2.
fn fail(message: &str) -> ! {
    log::mark(&format!("cannot start: {message}"));
    log::flush();
    eprintln!("{message}");
    std::process::exit(2)
}

fn run(args: &[String]) {
    let t0 = Instant::now();
    let gap = log::ms_since_process_creation();
    // startup.log next to the binary, the previous run kept as startup.prev.log. `--log FILE` writes just that file.
    match arg(args, "--log") {
        Some(path) => log::init(t0, gap, Some(path.into()), false),
        None => log::init(t0, gap, log::default_path(), true),
    }
    #[cfg(not(feature = "dev-start"))]
    if let Some(f) = ["--fake-device", "--demo-setup"].into_iter().find(|f| flag(args, f)) {
        fail(&format!("{f} is only in builds with the cargo feature dev-start"));
    }
    let env_dir = std::env::var_os("KASBOEK_DATA_DIR").is_some_and(|v| !v.is_empty());
    let named = arg(args, "--data-dir").is_some() || env_dir;
    // The folder of the Electron app, when no folder was named and it exists: opened only if the system can seal its
    // account file (no keyring on Linux: the app says so instead of showing the fixtures in place of the person's data).
    let electron_dir = if named { None } else { kb_service::resolve_data_dir(None).ok().filter(|d| d.is_dir()) };
    let electron_ready = electron_dir.as_deref().is_some_and(kb_service::os_seal_available);
    let kind = pick_service(args, env_dir, electron_ready).unwrap_or_else(|e| fail(&e));
    if electron_dir.is_some() && !electron_ready && arg(args, "--service").is_none() && !FIXTURE_FLAGS.iter().any(|f| flag(args, f)) {
        fail(NO_KEY_STORE);
    }
    // The fixtures keep their own folder: they must never write into the data of the Electron app.
    let data_dir = match kind {
        Kind::Fixture | Kind::CoreTemp => prefs::dev_data_dir(arg(args, "--data-dir")),
        Kind::Core => kb_service::resolve_data_dir(arg(args, "--data-dir").as_deref()),
    }
    .unwrap_or_else(|e| fail(&e));
    // `--service core` without a named folder is the Electron folder too: same condition.
    if kind == Kind::Core && !named && !kb_service::os_seal_available(&data_dir) {
        fail(NO_KEY_STORE);
    }
    std::panic::set_hook(Box::new(|info| {
        log::mark(&format!("PANIC: {info}"));
        log::flush();
        // A panic while the app shuts down (the start-up test is over by then) is its own, plain failure: exit code 101 as
        // for any panic, not whatever the abort of the runtime turns into.
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            std::process::exit(101);
        }
    }));
    match gap {
        Some(g) => log::mark(&format!("process start (OS creation time; main entered {g:.0} ms later)")),
        None => log::mark("process start (not known on this OS: times count from main)"),
    }
    log::mark("main entered");

    let mut prefs = prefs::Prefs::read(&data_dir.join("prefs.json"));
    if let Some(l) = arg(args, "--lang") {
        prefs.language = l;
    }
    if let Some(t @ ("light" | "dark" | "system")) = arg(args, "--theme").as_deref() {
        prefs.theme = t.to_string();
    }
    log::mark("prefs read");
    let exit_after_ms = arg(args, "--exit-after-ms").and_then(|v| v.parse::<u64>().ok());
    let exit_first = flag(args, "--exit-after-first-frame");
    let renderer = arg(args, "--renderer").unwrap_or_else(|| "software".into());
    log::mark(&format!(
        "settings: os={} arch={} theme={} lang={} state={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        prefs.theme,
        prefs.language,
        arg(args, "--state").unwrap_or_else(|| "locked".into())
    ));
    if let Some(scale) = arg(args, "--scale") {
        std::env::set_var("SLINT_SCALE_FACTOR", scale);
    }
    slint::BackendSelector::new().backend_name("winit".into()).renderer_name(renderer.clone()).select().expect("backend");
    log::mark(&format!("backend selected (renderer {renderer})"));

    log::mark(&format!("service: {kind:?}"));
    // The hidden development start (feature `dev-start`): create the account (or unlock it) with a password from the
    // environment, no screens. The variable is removed at once so that it does not reach child processes; the password is
    // moved into a wiped-on-drop holder and handed to the controller, not kept in the configuration.
    #[cfg(feature = "dev-start")]
    let demo_password = flag(args, "--demo-setup").then(|| {
        let password = std::env::var("KASBOEK_DEMO_PASSWORD").unwrap_or_else(|_| fail("--demo-setup needs KASBOEK_DEMO_PASSWORD"));
        std::env::remove_var("KASBOEK_DEMO_PASSWORD");
        zeroize::Zeroizing::new(password)
    });
    let window = Arc::new(Mutex::new(None));
    let service = service_from(args, kind, &data_dir, window.clone()).unwrap_or_else(|e| fail(&e));
    let ui = App::new().expect("ui");
    let cfg = app::Config {
        data_dir: data_dir.clone(),
        today: today_from(args),
        #[cfg(feature = "dev-start")]
        fake_device: flag(args, "--fake-device"),
        caption_inset: arg(args, "--inset").and_then(|v| v.parse().ok()).unwrap_or(12.0),
        device_in_service: kind != Kind::Fixture,
    };
    kb_ui::wire_rules!(&ui);
    let ctl = app::Ctl::attach(&ui, service.clone(), cfg, &prefs);
    #[cfg(feature = "dev-start")]
    if let Some(password) = demo_password {
        ctl.set_demo_password(password);
    }
    log::mark("window created");

    let first = Rc::new(RefCell::new(false));
    // The software renderer has no first-paint hook: the first timer tick after show() is the upper bound.
    let notifier = {
        let first = first.clone();
        ui.window()
            .set_rendering_notifier(move |state, _| {
                if matches!(state, slint::RenderingState::AfterRendering) && !*first.borrow() {
                    *first.borrow_mut() = true;
                    first_frame("first frame painted", exit_first);
                }
            })
            .is_ok()
    };
    ui.show().expect("show");
    *window.lock().unwrap_or_else(|e| e.into_inner()) = device::window_id(ui.window());
    log::mark("window shown (show() returned)");
    if !notifier {
        slint::Timer::single_shot(Duration::from_millis(16), move || {
            first_frame("first frame painted (software renderer has no hook: 16 ms timer after show, upper bound)", exit_first)
        });
    }
    // After the first frame: the real status, and the system theme when the pref says `system`.
    let start = ctl.clone();
    slint::Timer::single_shot(Duration::from_millis(0), move || start.start());
    if prefs.theme == "system" {
        let weak = ui.as_weak();
        let path = data_dir.join("prefs.json");
        let service = service.clone();
        std::thread::spawn(move || {
            let Some(now_dark) = titlebar::system_dark() else { return };
            let last = serde_json::json!(if now_dark { "dark" } else { "light" });
            if !service.cache_pref("lastTheme", last.clone()) {
                kb_service::update_prefs_key(&path, "lastTheme", Some(last));
            }
            let _ = weak.upgrade_in_event_loop(move |ui| {
                if let Some(c) = ctl_get() {
                    c.set_theme(&ui, now_dark);
                }
            });
        });
    }
    if let Some(ms) = exit_after_ms {
        slint::Timer::single_shot(Duration::from_millis(ms), || {
            let _ = slint::quit_event_loop();
        });
    }
    slint::run_event_loop().expect("event loop");
    log::mark("event loop ended");
    shutdown(&*service);
    log::flush();
}

/// How long the service gets to stop its worker.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Set when the event loop is over: a panic from here on exits with code 101.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// The end of the app, in order, each step in the log: the controller is let go of (its thread-local would otherwise drop the
/// service in a destructor at process exit), the service stops its worker and closes the database. Nothing is joined later.
fn shutdown(service: &dyn AppService) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    log::mark("shutdown: releasing the controller");
    app::release();
    log::mark("shutdown: stopping service");
    log::flush();
    let ended = service.shutdown(SHUTDOWN_TIMEOUT);
    log::mark(if ended { "shutdown: worker joined" } else { "shutdown: worker still busy after the timeout, left alone" });
    log::mark("shutdown: done");
}

fn ctl_get() -> Option<Rc<app::Ctl>> {
    app::current()
}

fn first_frame(what: &str, exit: bool) {
    log::mark(what);
    log::mark(&format!("time-to-first-frame {:.0} ms", log::now_ms()));
    // A start that is killed or crashes later still leaves its milestones.
    slint::Timer::single_shot(Duration::from_millis(300), log::flush);
    if exit {
        let _ = slint::quit_event_loop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| (*a).to_string()).collect()
    }

    #[test]
    fn the_real_service_runs_when_a_data_folder_is_given_or_the_electron_folder_is_ready() {
        assert_eq!(pick_service(&args(&[]), false, false), Ok(Kind::Fixture));
        assert_eq!(pick_service(&args(&["--data-dir", "/x"]), false, false), Ok(Kind::Core));
        assert_eq!(pick_service(&args(&[]), true, false), Ok(Kind::Core));
        assert_eq!(pick_service(&args(&[]), false, true), Ok(Kind::Core));
    }

    #[test]
    fn the_fixture_flags_and_an_explicit_service_win() {
        assert_eq!(pick_service(&args(&["--state", "unlocked"]), false, true), Ok(Kind::Fixture));
        assert_eq!(pick_service(&args(&["--service", "core"]), false, false), Ok(Kind::Core));
        assert_eq!(pick_service(&args(&["--service", "fixture", "--data-dir", "/x"]), true, true), Ok(Kind::Fixture));
        assert_eq!(pick_service(&args(&["--service", "core-temp", "--state", "unlocked"]), false, false), Ok(Kind::CoreTemp));
        assert!(pick_service(&args(&["--service", "nope"]), false, false).is_err());
    }
}
