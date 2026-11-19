//! The controller: wires the screens to the `AppService`. Everything that touches the screen runs on the UI thread; service
//! calls run on a worker thread of their own and come back through `upgrade_in_event_loop`.
use crate::device::{self, Event, Outcome, Report};
use crate::format::Formats;
use crate::loading::{self, Gate, Progress};
use crate::prefs::{self, LastAuth, Prefs};
use crate::view::{self, OverviewData, Res};
use crate::{log, titlebar, App, Loading, Lock, Ov, RuleRow, SetupState, ShellState, Tx};
use kb_i18n::Catalog;
use kb_service::{AppError, AppEvent, AppService, LoadStep};
use serde_json::{json, Value};
use slint::{ComponentHandle, Model, ModelRc, SharedString, Timer, TimerMode, VecModel};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Config {
    pub data_dir: PathBuf,
    /// Today as (year, month, day): the system clock, or `--today`.
    pub today: (i32, u32, u32),
    /// Answer the device prompt with "verified" without asking the OS (fixtures on Linux, tests).
    pub fake_device: bool,
    /// The space the window controls take at the right of the top bar (Electron draws them into the page: 148 px).
    pub caption_inset: f32,
}

#[derive(Default)]
struct State {
    month: (i32, u32),
    data: Option<Rc<OverviewData>>,
    tips_all: bool,
    progress: Progress,
    unlocked_at: Option<Instant>,
    loading_since: Option<u64>,
    ready: bool,
    pending: Option<OverviewData>,
    throttle_left: u64,
    toast_id: i32,
}

pub struct Ctl {
    ui: slint::Weak<App>,
    service: Arc<dyn AppService>,
    cat: Rc<Catalog>,
    prefs_path: PathBuf,
    cfg: Config,
    fmt: RefCell<Formats>,
    state: RefCell<State>,
    status: RefCell<Value>,
    toasts: Rc<VecModel<crate::ToastItem>>,
    gate_timer: Timer,
    throttle_timer: Timer,
    device_started: Cell<Option<Instant>>,
}

thread_local! {
    static CTL: RefCell<Option<Rc<Ctl>>> = const { RefCell::new(None) };
}

/// Runs `f` with the controller (UI thread only).
fn with(f: impl FnOnce(&Rc<Ctl>)) {
    if let Some(c) = CTL.with(|c| c.borrow().clone()) {
        f(&c);
    }
}

fn s(text: impl Into<SharedString>) -> SharedString {
    text.into()
}

const THEME_COLOURS: [(u32, u32); 2] = [(0xfafaf8, 0x18201b), (0x0e110f, 0xe7ece8)];

impl Ctl {
    /// Builds the controller and connects every callback of `ui`. `prefs` gives the first frame its theme and lock mode.
    pub fn attach(ui: &App, service: Arc<dyn AppService>, cfg: Config, prefs: &Prefs) -> Rc<Ctl> {
        let cat = Rc::new(Catalog::new(&prefs.language));
        let toasts = Rc::new(VecModel::<crate::ToastItem>::default());
        ui.set_toasts(ModelRc::from(toasts.clone()));
        let today = (cfg.today.0, cfg.today.1);
        let ctl = Rc::new(Ctl {
            ui: ui.as_weak(),
            service,
            cat,
            prefs_path: cfg.data_dir.join("prefs.json"),
            fmt: RefCell::new(Formats::from_json(&prefs.formats)),
            cfg,
            state: RefCell::new(State { month: today, ..State::default() }),
            status: RefCell::new(Value::Null),
            toasts,
            gate_timer: Timer::default(),
            throttle_timer: Timer::default(),
            device_started: Cell::new(None),
        });
        CTL.with(|c| *c.borrow_mut() = Some(ctl.clone()));
        ctl.wire(ui);
        ctl.set_theme(ui, prefs.first_frame_dark());
        ui.global::<ShellState>().set_caption_inset(ctl.cfg.caption_inset);
        ui.global::<ShellState>().set_version_text(ctl.cat.tv("app.versionShort", &[("version", env!("CARGO_PKG_VERSION"))]).into());
        ui.global::<ShellState>().set_placeholder_heading(ctl.cat.t("native.notPortedTitle").into());
        ui.global::<ShellState>().set_placeholder_body(ctl.cat.t("native.notPortedBody").into());
        ui.global::<ShellState>().set_assistant_note(ctl.cat.t("native.assistantNote").into());
        ui.set_window_title(ctl.cat.t("app.name").into());
        // The first frame is the Lock screen in the cached mode; the real status corrects it.
        let status = match &prefs.last_auth {
            Some(a) => {
                json!({ "state": "locked", "mode": a.mode, "device": a.device, "twoFactor": a.two_factor, "rememberedUntil": a.remembered_until, "throttleSeconds": 0 })
            }
            None => {
                json!({ "state": "locked", "mode": "password", "device": null, "twoFactor": false, "rememberedUntil": null, "throttleSeconds": 0 })
            }
        };
        ctl.show_lock(ui, &status);
        // Language-dependent texts.
        let weak = Rc::downgrade(&ctl.cat);
        ui.global::<Tx>().on_t(move |key, _| weak.upgrade().map_or_else(|| key.clone(), |c| c.t(&key).into()));
        ctl
    }

    pub fn set_theme(&self, ui: &App, dark: bool) {
        ui.set_dark(dark);
        let (bg, text) = THEME_COLOURS[usize::from(dark)];
        titlebar::apply(ui.window(), dark, bg, text);
    }

    /// Asks the service for the real status (in the background) and shows the screen it names.
    pub fn start(self: &Rc<Self>) {
        self.run("auth.status", json!({}), |c, ui, res| match res {
            Ok(st) => c.apply_status(ui, &st),
            Err(e) => {
                let mut st = json!({ "state": "locked", "mode": "password", "throttleSeconds": 0 });
                st["error"] = json!({ "code": e.code, "message": e.message });
                c.apply_status(ui, &st);
            }
        });
    }

    /// Runs a service call on a worker thread and hands the answer to `then` on the UI thread.
    fn run(&self, op: &'static str, input: Value, then: impl FnOnce(&Rc<Ctl>, &App, Res) + Send + 'static) {
        let (service, weak) = (self.service.clone(), self.ui.clone());
        std::thread::spawn(move || {
            let res = kb_service::block_on(service.invoke(op, input));
            let _ = weak.upgrade_in_event_loop(move |ui| with(|c| then(c, &ui, res)));
        });
    }

    fn wire(self: &Rc<Self>, ui: &App) {
        let lock = ui.global::<Lock>();
        lock.on_unlock(|p, code, remember| with(|c| c.unlock(&p, &code, remember)));
        lock.on_recover(|key| with(|c| c.recover(&key)));
        lock.on_erase(|| with(|c| c.erase()));
        lock.on_retry(|| with(|c| c.start()));
        let setup = ui.global::<SetupState>();
        setup.on_password_edited(|t| with(|c| c.password_edited(&t)));
        setup.on_create_password(|p| with(|c| c.create(json!({ "mode": "password", "password": p.as_str() }))));
        setup.on_create_device(|| with(|c| c.create(json!({ "mode": "device" }))));
        setup.on_finished(|| with(|c| c.start()));
        let shell = ui.global::<ShellState>();
        shell.on_go(|page| with(|c| c.go(&page)));
        shell.on_about(|| with(|c| c.go("settings")));
        shell.on_lock(|| with(|c| c.lock()));
        let ov = ui.global::<Ov>();
        ov.on_month_changed(|y, m| with(|c| c.change_month(y, m as u32)));
        ov.on_toggle_tips(|| with(|c| c.toggle_tips()));
        ov.on_show_all(|| with(|c| c.show_all()));
        ov.on_get_tips(|| with(|c| c.not_ported_toast("insights.run")));
        ov.on_review(|| with(|c| c.not_ported_toast("assistant.send")));
        ov.on_tip_feedback(|_, _| with(|c| c.not_ported_toast("insights.feedback")));
        let weak = ui.as_weak();
        ui.on_dismiss_toast(move |id| {
            if let Some(ui) = weak.upgrade() {
                with(|c| c.dismiss_toast(&ui, id));
            }
        });
        // Events: data changed -> reload the month; locked -> the Lock screen; progress -> the loading view.
        let sink = Mutex::new(ui.as_weak());
        self.service.subscribe(Arc::new(move |event| {
            let weak = sink.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let _ = weak.upgrade_in_event_loop(move |ui| with(|c| c.on_event(&ui, event)));
        }));
    }

    fn on_event(self: &Rc<Self>, ui: &App, event: AppEvent) {
        match event {
            AppEvent::LoadProgress { step, done, total } => self.progress(ui, step, done, total),
            AppEvent::DataChanged { .. } | AppEvent::SettingsChanged | AppEvent::InsightsUpdated { .. } => {
                if ui.get_screen() == "shell" {
                    self.reload(None);
                }
            }
            AppEvent::Locked { .. } => self.start(),
            _ => {}
        }
    }

    // ---- text helpers ----

    fn err_text(&self, e: &AppError) -> String {
        let key = format!("errors.{}", e.code.replace('.', "_"));
        let text = self.cat.t(&key);
        if text == key {
            e.message.clone()
        } else {
            text
        }
    }

    fn toast(&self, tone: &str, message: String) {
        let id = {
            let mut st = self.state.borrow_mut();
            st.toast_id += 1;
            st.toast_id
        };
        self.toasts.push(crate::ToastItem { id, tone: tone.into(), message: message.into() });
    }

    fn dismiss_toast(&self, _ui: &App, id: i32) {
        if let Some(i) = self.toasts.iter().position(|t| t.id == id) {
            self.toasts.remove(i);
        }
    }

    /// A button whose operation is not ported: a toast says so instead of doing nothing.
    fn not_ported_toast(&self, op: &str) {
        self.toast("error", self.cat.tv("native.opNotPorted", &[("op", op)]));
    }

    // ---- status and the screens ----

    fn apply_status(self: &Rc<Self>, ui: &App, st: &Value) {
        *self.status.borrow_mut() = st.clone();
        match st["state"].as_str().unwrap_or("locked") {
            "setup" => self.show_setup(ui, st),
            "unlocked" => self.begin_load(ui),
            _ => self.show_lock(ui, st),
        }
    }

    fn device_name(&self, kind: &str) -> String {
        self.cat.t(if kind == "touch-id" { "auth.touchId" } else { "auth.windowsHello" })
    }

    pub fn show_lock(&self, ui: &App, st: &Value) {
        let lock = ui.global::<Lock>();
        let device = st["mode"] == "device";
        let kind = st["device"].as_str().unwrap_or("");
        let name = self.device_name(if kind.is_empty() && cfg!(target_os = "macos") { "touch-id" } else { kind });
        lock.set_mode(s(if device { "device" } else { "password" }));
        lock.set_device_kind(s(kind));
        lock.set_device_name(s(name.clone()));
        lock.set_body(s(if device { self.cat.tv("auth.unlockDeviceBody", &[("name", &name)]) } else { String::new() }));
        let need_code = st["twoFactor"].as_bool().unwrap_or(false) && st["rememberedUntil"].is_null();
        lock.set_need_code(need_code);
        lock.set_remembered_note(s(match (st["twoFactor"].as_bool().unwrap_or(false), st["rememberedUntil"].as_str()) {
            (true, Some(until)) => {
                self.cat.tv("auth.rememberedNote", &[("date", &self.fmt.borrow().date(until.get(..10).unwrap_or(until)))])
            }
            _ => String::new(),
        }));
        lock.set_cant_open(s(st["error"]["message"].as_str().unwrap_or("")));
        lock.set_erase_word(s(self.cat.t("auth.eraseWord")));
        lock.set_busy(false);
        lock.set_error(s(""));
        lock.set_view(s("unlock"));
        self.start_throttle(ui, st["throttleSeconds"].as_u64().unwrap_or(0));
        ui.set_screen(s("lock"));
    }

    fn start_throttle(&self, ui: &App, seconds: u64) {
        self.state.borrow_mut().throttle_left = seconds;
        self.throttle_timer.stop();
        let lock = ui.global::<Lock>();
        if seconds == 0 {
            lock.set_throttle(s(""));
            return;
        }
        lock.set_throttle(s(self.cat.tv("auth.throttled", &[("s", &seconds.to_string())])));
        self.throttle_timer.start(TimerMode::Repeated, Duration::from_secs(1), || {
            with(|c| {
                let left = {
                    let mut st = c.state.borrow_mut();
                    st.throttle_left = st.throttle_left.saturating_sub(1);
                    st.throttle_left
                };
                let Some(ui) = c.ui.upgrade() else { return };
                let text = if left == 0 { String::new() } else { c.cat.tv("auth.throttled", &[("s", &left.to_string())]) };
                ui.global::<Lock>().set_throttle(s(text));
                if left == 0 {
                    c.throttle_timer.stop();
                }
            });
        });
    }

    pub fn show_setup(&self, ui: &App, st: &Value) {
        let setup = ui.global::<SetupState>();
        let kind = st["device"].as_str().unwrap_or("");
        let os_ok = st["keyProtection"].as_str().unwrap_or("os") == "os";
        setup.set_body(s(self.cat.t(if st["legacyData"].as_bool().unwrap_or(false) { "auth.welcomeLegacy" } else { "auth.welcomeBody" })));
        setup.set_device_kind(s(kind));
        setup.set_device_title(s(if kind.is_empty() {
            self.cat.t("auth.choosePasswordless")
        } else {
            self.cat.tv("auth.chooseDevice", &[("name", &self.device_name(kind))])
        }));
        setup.set_device_enabled(!kind.is_empty() && os_ok);
        setup.set_device_note(s(if !kind.is_empty() {
            if os_ok {
                String::new()
            } else {
                self.cat.t("auth.deviceUnprotectedHint")
            }
        } else if st["deviceChecking"].as_bool().unwrap_or(false) {
            self.cat.t("auth.deviceChecking")
        } else {
            self.cat.t("auth.deviceUnavailableHint")
        }));
        setup.set_step(s("choose"));
        self.password_edited("");
        ui.set_screen(s("setup"));
    }

    pub fn password_edited(&self, text: &str) {
        let Some(ui) = self.ui.upgrade() else { return };
        let check = kb_rules::password::check_password(text);
        use kb_rules::password::PasswordIssue::{AppName, Common, Pattern};
        let has = |i| check.issues.contains(&i);
        let rule = |ok: bool, label: String| RuleRow { ok, label: label.into() };
        let n = kb_rules::password::MIN_PASSWORD_LENGTH.to_string();
        let rules = vec![
            rule(text.chars().count() >= kb_rules::password::MIN_PASSWORD_LENGTH, self.cat.tv("auth.ruleLength", &[("n", &n)])),
            rule(check.classes >= 3, self.cat.t("auth.ruleVariety")),
            rule(!text.is_empty() && !has(Common) && !has(AppName), self.cat.t("auth.ruleCommon")),
            rule(!text.is_empty() && !has(Pattern), self.cat.t("auth.rulePattern")),
        ];
        let setup = ui.global::<SetupState>();
        setup.set_strength(i32::from(check.strength));
        // The strength meter reaches "strong" only when every rule passes, as the meter of the renderer counts.
        setup.set_strength_text(s(if text.is_empty() {
            self.cat.t("auth.strengthHint")
        } else {
            self.cat.t(&format!("auth.strength{}", check.strength))
        }));
        setup.set_rules(ModelRc::new(VecModel::from(rules)));
    }

    fn create(&self, input: Value) {
        let Some(ui) = self.ui.upgrade() else { return };
        ui.global::<SetupState>().set_busy(true);
        ui.global::<SetupState>().set_error(s(""));
        self.run("auth.setup", input, |c, ui, res| {
            let setup = ui.global::<SetupState>();
            setup.set_busy(false);
            match res {
                Ok(r) => {
                    let key = r["recoveryKey"].as_str().unwrap_or("");
                    let groups: Vec<&str> = key.split('-').collect();
                    setup.set_recovery_key_top(s(groups.iter().take(4).copied().collect::<Vec<_>>().join("-")));
                    setup.set_recovery_key_bottom(s(groups.iter().skip(4).copied().collect::<Vec<_>>().join("-")));
                    setup.set_step(s("recovery"));
                }
                Err(e) => setup.set_error(s(c.err_text(&e))),
            }
        });
    }

    // ---- unlock ----

    fn unlock(&self, password: &str, code: &str, remember: bool) {
        let Some(ui) = self.ui.upgrade() else { return };
        let lock = ui.global::<Lock>();
        if lock.get_busy() {
            return;
        }
        let device = lock.get_mode() == "device";
        let mut input = json!({});
        if !device {
            input["password"] = json!(password);
        }
        if lock.get_need_code() {
            input["code"] = json!(code);
            input["remember"] = json!(remember);
        }
        lock.set_busy(true);
        lock.set_error(s(""));
        if device {
            self.press_device(&ui, input);
        } else {
            self.submit(input);
        }
    }

    fn submit(&self, input: Value) {
        let started = Instant::now();
        self.run("auth.unlock", input, move |c, ui, res| {
            let lock = ui.global::<Lock>();
            lock.set_password(s(""));
            match res {
                Ok(st) => {
                    log::mark(&format!("kdf done ({:.0} ms)", started.elapsed().as_secs_f64() * 1000.0));
                    if let Some(auth) = LastAuth::from_status(&st) {
                        prefs::update(&c.prefs_path, &[("lastAuth", auth.to_json())]);
                    }
                    c.apply_status(ui, &st);
                }
                Err(e) => {
                    lock.set_busy(false);
                    lock.set_error(s(c.err_text(&e)));
                    lock.set_code(s(""));
                    // The throttle after a wrong try comes from the status.
                    c.run("auth.status", json!({}), |c, ui, res| {
                        if let Ok(st) = res {
                            c.start_throttle(ui, st["throttleSeconds"].as_u64().unwrap_or(0));
                        }
                    });
                }
            }
        });
    }

    /// The OS prompt, only on the press of the button. On an answer of "verified" the unlock goes on.
    fn press_device(&self, ui: &App, input: Value) {
        log::mark("device prompt requested");
        self.device_started.set(Some(Instant::now()));
        let pressed = Instant::now();
        let weak = self.ui.clone();
        let input = Arc::new(Mutex::new(Some(input)));
        let report: Report = Arc::new(move |event| {
            let since = pressed.elapsed().as_millis();
            match event {
                Event::Info(text) => log::mark(&format!("device: {text}")),
                Event::Shown(how) => {
                    log::mark(&format!("device prompt shown ({how}), {since} ms after press"));
                    log::mark(&format!("time-to-prompt {since} ms"));
                }
                Event::Answered(outcome, detail) => {
                    log::mark(&format!("device answered ({}), {since} ms after press: {detail}", outcome.word()));
                    log::flush();
                    let input = input.lock().unwrap_or_else(|e| e.into_inner()).take();
                    let _ = weak.upgrade_in_event_loop(move |ui| {
                        with(|c| match (outcome, input) {
                            (Outcome::Verified, Some(input)) => c.submit(input),
                            (o, _) => {
                                let lock = ui.global::<Lock>();
                                lock.set_busy(false);
                                if o != Outcome::Cancelled {
                                    lock.set_error(s(c.cat.t(if cfg!(target_os = "macos") {
                                        "auth.deviceUnavailableHint"
                                    } else {
                                        "errors.auth_device_unavailable"
                                    })));
                                }
                            }
                        })
                    });
                }
            }
        });
        if self.cfg.fake_device {
            report(Event::Shown("fake device".into()));
            report(Event::Answered(Outcome::Verified, "--fake-device".into()));
            return;
        }
        device::request(device::window_id(ui.window()), &self.cat.t("auth.unlockTitle"), report);
    }

    fn recover(&self, key: &str) {
        let Some(ui) = self.ui.upgrade() else { return };
        ui.global::<Lock>().set_busy(true);
        self.run("auth.unlockRecovery", json!({ "recoveryKey": key }), |c, ui, res| match res {
            Ok(st) => c.apply_status(ui, &st),
            Err(e) => {
                let lock = ui.global::<Lock>();
                lock.set_busy(false);
                lock.set_error(s(c.err_text(&e)));
            }
        });
    }

    fn erase(&self) {
        self.run("auth.erase", json!({ "confirm": "ERASE" }), |c, ui, res| match res {
            Ok(st) => c.apply_status(ui, &st),
            Err(e) => ui.global::<Lock>().set_error(s(c.err_text(&e))),
        });
    }

    fn lock(&self) {
        self.run("auth.lock", json!({}), |c, ui, res| {
            c.state.borrow_mut().data = None;
            // Revealed secrets are hidden again when the app locks.
            let session = ui.global::<crate::Session>();
            session.set_hide_secrets(session.get_hide_secrets() + 1);
            let st = res.unwrap_or_else(|_| json!({ "state": "locked", "mode": "password", "throttleSeconds": 0 }));
            c.apply_status(ui, &st);
        });
    }

    // ---- loading and the Overview ----

    pub fn progress(&self, ui: &App, step: LoadStep, done: u64, total: u64) {
        let (text, value) = {
            let mut st = self.state.borrow_mut();
            st.progress.report(step, done, total);
            (self.cat.t(st.progress.step().key()), st.progress.value())
        };
        let loading = ui.global::<Loading>();
        loading.set_step_text(s(text));
        loading.set_value(value);
    }

    /// After a successful unlock: the loading starts, the 180 ms timer runs, the loading view shows only if needed.
    fn begin_load(self: &Rc<Self>, ui: &App) {
        {
            let mut st = self.state.borrow_mut();
            st.unlocked_at = Some(Instant::now());
            st.loading_since = None;
            st.ready = false;
            st.pending = None;
            st.progress = Progress::default();
        }
        self.progress(ui, LoadStep::Opening, 1, 1);
        let (year, month) = self.state.borrow().month;
        let (service, weak) = (self.service.clone(), self.ui.clone());
        std::thread::spawn(move || {
            let reporter = weak.clone();
            let data = view::fetch(service.as_ref(), year, month, &mut |step, done, total| {
                let _ = reporter.upgrade_in_event_loop(move |ui| with(|c| c.progress(&ui, step, done, total)));
            });
            let _ = weak.upgrade_in_event_loop(move |ui| {
                with(|c| {
                    {
                        let mut st = c.state.borrow_mut();
                        st.pending = Some(data);
                        st.ready = true;
                    }
                    c.tick(&ui);
                })
            });
        });
        self.gate_timer.start(TimerMode::Repeated, Duration::from_millis(20), || {
            with(|c| {
                if let Some(ui) = c.ui.upgrade() {
                    c.tick(&ui);
                }
            })
        });
    }

    fn tick(&self, ui: &App) {
        let (elapsed, ready, since) = {
            let st = self.state.borrow();
            let Some(t0) = st.unlocked_at else { return };
            (t0.elapsed().as_millis() as u64, st.ready, st.loading_since)
        };
        match loading::gate(elapsed, ready, since) {
            Gate::Wait => {}
            Gate::ShowLoading => {
                self.state.borrow_mut().loading_since = Some(elapsed);
                let loading = ui.global::<Loading>();
                let (text, value) = {
                    let st = self.state.borrow();
                    (self.cat.t(st.progress.step().key()), st.progress.value())
                };
                loading.set_step_text(s(text));
                loading.set_value(value);
                ui.set_screen(s("loading"));
                log::mark("loading view shown");
            }
            Gate::Finish => {
                self.gate_timer.stop();
                let (data, tips_all) = {
                    let mut st = self.state.borrow_mut();
                    st.unlocked_at = None;
                    (st.pending.take(), st.tips_all)
                };
                if let Some(data) = data {
                    self.show_overview(ui, data, tips_all);
                    ui.set_screen(s("shell"));
                    log::mark("first unlocked frame");
                    log::mark(&format!("time-to-unlocked {:.0} ms", log::now_ms()));
                    log::flush();
                }
            }
        }
    }

    /// Shows the Overview with data already fetched (also what the screenshots use).
    pub fn show_overview(&self, ui: &App, data: OverviewData, tips_all: bool) {
        let opts = view::Options { tips_all, today: (self.cfg.today.0, self.cfg.today.1) };
        view::apply(ui, &self.cat, &self.fmt.borrow(), &data, &opts);
        self.state.borrow_mut().data = Some(Rc::new(data));
        if ui.global::<ShellState>().get_page().is_empty() {
            ui.global::<ShellState>().set_page(s("overview"));
        }
    }

    /// Re-reads the month shown (data changed, month changed), without a loading view.
    fn reload(self: &Rc<Self>, month: Option<(i32, u32)>) {
        if let Some(m) = month {
            self.state.borrow_mut().month = m;
        }
        let (year, month) = self.state.borrow().month;
        let (service, weak) = (self.service.clone(), self.ui.clone());
        std::thread::spawn(move || {
            let data = view::fetch(service.as_ref(), year, month, &mut |_, _, _| {});
            let _ = weak.upgrade_in_event_loop(move |ui| {
                with(|c| {
                    let (current, tips_all) = {
                        let st = c.state.borrow();
                        (st.month, st.tips_all)
                    };
                    // An answer for a month that is no longer shown is dropped.
                    if current == (year, month) && ui.get_screen() == "shell" {
                        c.show_overview(&ui, data, tips_all);
                    }
                })
            });
        });
    }

    fn change_month(self: &Rc<Self>, year: i32, month: u32) {
        self.reload(Some((year, month)));
    }

    fn toggle_tips(&self) {
        if let Some(ui) = self.ui.upgrade() {
            let ov = ui.global::<Ov>();
            ov.set_tips_collapsed(!ov.get_tips_collapsed());
        }
    }

    fn show_all(&self) {
        let (Some(ui), Some(data)) = (self.ui.upgrade(), self.state.borrow().data.clone()) else { return };
        let all = {
            let mut st = self.state.borrow_mut();
            st.tips_all = !st.tips_all;
            st.tips_all
        };
        let opts = view::Options { tips_all: all, today: (self.cfg.today.0, self.cfg.today.1) };
        view::apply(&ui, &self.cat, &self.fmt.borrow(), &data, &opts);
    }

    fn go(&self, page: &str) {
        if let Some(ui) = self.ui.upgrade() {
            ui.global::<ShellState>().set_page(s(page));
        }
    }
}

/// The controller of this thread's window, if any.
pub fn current() -> Option<Rc<Ctl>> {
    CTL.with(|c| c.borrow().clone())
}
