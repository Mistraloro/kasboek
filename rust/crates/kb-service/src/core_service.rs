//! `CoreService`: the real service. One worker thread owns a `kb-session` `Session` (account, unlock, lock, throttle,
//! 2FA) and a `kb-core` `Core` (all other operations) on the data folder; requests travel to it over a channel (the
//! "one DB worker" of the plan). The dispatch rules are those of `dispatch` in src/main/ipc.ts:
//!
//! - `app.*` and `prefs.*` go ahead of the session (they only need `prefs.json`);
//! - every other operation waits until the account file was read (the worker reads it first, the queue holds the rest);
//! - while locked only the login operations run, everything else answers `auth.locked`.
//!
//! The database is opened by the session on unlock (the vault's key), the core gets its own handle to the same file,
//! and both are dropped when the session locks (the session wipes its key material; the core's copy of the key is a
//! `DbKey`, wiped on drop, and only lives while the handle is opened). The idle timer and the lock/suspend events of
//! the system lock the session from the same worker.
use crate::prefs_store::PrefsStore;
use crate::{AppError, AppEvent, AppService, Listener, Listeners, LoadStep, OpFuture, DEMO_PASSWORD};
use kb_core::{locked_refusal, Actor, Core, CoreConfig, SeededRng};
use kb_crypto::slot::Argon2Cost;
use kb_db::{DbKey, OpenOptions, SqliteStore, Store, SCHEMA_VERSION};
use kb_session::account::{Attempts, AuthMode};
use kb_session::device::{DeviceAuth, NoDevice};
use kb_session::ops::{register_ops, OpHandler};
use kb_session::seal::{FileSeal, OsSeal, Unsupported};
use kb_session::session::{Event, Hint, LockReason};
use kb_session::time::{Clock as SessionClock, ManualClock, OsRng, SystemClock as SessionSystemClock};
use kb_session::{Config, Paths, Session};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

type Reply = Sender<Result<Value, AppError>>;

enum Msg {
    Op(String, Value, Reply),
    /// The idle timer: check the auto-lock.
    Tick,
    /// The system locked the screen or went to sleep.
    SystemLock,
    /// The service is dropped.
    Stop,
}

/// What the operating system tells about the person being away. The real sources (idle time, screen lock, suspend)
/// are platform code; [`NoOsEvents`] is the stand-in until they exist.
pub trait OsEvents: Send + Sync {
    /// Seconds since the last keyboard or pointer input of the person, if the system can tell.
    fn idle_seconds(&self) -> Option<u64>;
    /// Calls `on_lock` whenever the system locks the screen or goes to sleep. Called once, at start.
    fn on_system_lock(&self, on_lock: Box<dyn Fn() + Send + Sync>);
}

/// No system events: the idle timer counts from the last thing the person did in the app (service calls and
/// [`AppService::activity`]), and nothing reports a lock.
pub struct NoOsEvents;

impl OsEvents for NoOsEvents {
    fn idle_seconds(&self) -> Option<u64> {
        None
    }

    fn on_system_lock(&self, _on_lock: Box<dyn Fn() + Send + Sync>) {}
}

/// Lets the core read the same (injectable) time as the session.
pub struct ClockAdapter {
    pub clock: Arc<dyn SessionClock>,
    pub utc_offset_minutes: i32,
}

impl kb_core::Clock for ClockAdapter {
    fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    fn utc_offset_minutes(&self) -> i32 {
        self.utc_offset_minutes
    }
}

pub struct CoreOptions {
    pub data_dir: PathBuf,
    /// The seal around account.json. `Unsupported` writes `seal: 'none'` and cannot open `seal: 'os'` files.
    pub seal: Box<dyn OsSeal>,
    pub device: Box<dyn DeviceAuth>,
    pub os_events: Arc<dyn OsEvents>,
    /// Time of the session and the core (tests move it by hand). The system clock when `None`.
    pub clock: Option<Arc<dyn SessionClock>>,
    /// Argon2id cost for new password slots (tests lower it).
    pub cost: Option<Argon2Cost>,
    /// How often the idle timer looks (15 seconds in the app).
    pub tick: Duration,
    /// Minutes the person's clock is ahead of UTC.
    pub utc_offset_minutes: i32,
}

impl CoreOptions {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            seal: Box::new(Unsupported),
            device: Box::new(NoDevice),
            os_events: Arc::new(NoOsEvents),
            clock: None,
            cost: None,
            tick: Duration::from_secs(15),
            utc_offset_minutes: 0,
        }
    }
}

pub struct CoreService {
    tx: Mutex<Sender<Msg>>,
    listeners: Arc<Listeners>,
    prefs: Arc<PrefsStore>,
    data_dir: PathBuf,
    last_activity: Arc<Mutex<Instant>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    // Dropping this stops the idle timer thread.
    _ticker: Sender<()>,
    // Keeps the folder of `temporary` alive; it is deleted after the worker has closed the database.
    _temp: Option<tempfile::TempDir>,
}

/// 2026-11-14T10:00:00Z, the day of the invented household.
const NOW_MS: i64 = 1_794_650_400_000;

/// `nl_BE.UTF-8` -> `nl-BE`: the system's preferred languages, for the first start.
fn system_languages() -> Vec<String> {
    let lang =
        ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|v| std::env::var(v).ok().filter(|l| !l.is_empty() && l != "C" && l != "POSIX"));
    lang.map(|l| vec![l.split(['.', '@']).next().unwrap_or("en").replace('_', "-")]).unwrap_or_default()
}

fn hint_from(prefs: &PrefsStore) -> Option<Hint> {
    let last = prefs.raw().remove("lastAuth")?;
    let mode = match last["mode"].as_str()? {
        "password" => AuthMode::Password,
        "device" => AuthMode::Device,
        _ => return None,
    };
    Some(Hint {
        mode,
        two_factor: last["twoFactor"].as_bool().unwrap_or(false),
        remembered_until: last["rememberedUntil"].as_str().map(str::to_owned),
        attempts: Attempts { failed: 0, last_failed_at: None },
    })
}

impl CoreService {
    pub fn open(options: CoreOptions) -> Result<Self, AppError> {
        Self::start(options, None)
    }

    fn start(options: CoreOptions, temp: Option<tempfile::TempDir>) -> Result<Self, AppError> {
        let CoreOptions { data_dir, seal, device, os_events, clock, cost, tick, utc_offset_minutes } = options;
        std::fs::create_dir_all(&data_dir).map_err(|_| AppError::failed())?;
        let listeners = Arc::new(Listeners::default());
        let prefs = Arc::new(PrefsStore::new(data_dir.join("prefs.json"), system_languages(), utc_offset_minutes));
        let hint = hint_from(&prefs);
        let session_clock: Arc<dyn SessionClock> = clock.unwrap_or_else(|| Arc::new(SessionSystemClock));
        let mut config = Config::new(Paths::in_dir(&data_dir), Box::new(session_clock.clone()), Box::new(OsRng), seal, device);
        if let Some(cost) = cost {
            config.cost = cost;
        }
        let (tx, rx) = channel::<Msg>();
        let (stop_tx, stop_rx) = channel::<()>();
        let activity = Arc::new(Mutex::new(Instant::now()));
        let worker = {
            let (listeners, prefs, data_dir) = (listeners.clone(), prefs.clone(), data_dir.clone());
            let (activity, os_events) = (activity.clone(), os_events.clone());
            std::thread::Builder::new()
                .name("kb-service".into())
                .spawn(move || {
                    let mut session = Session::<SqliteStore>::new(config);
                    let sink = listeners.clone();
                    session.set_event_sink(move |event| {
                        sink.emit(match event {
                            Event::Locked(reason) => AppEvent::Locked { reason: reason.as_str().into() },
                            Event::Refresh => AppEvent::AuthRefresh,
                        })
                    });
                    session.set_qr_renderer(qr_svg);
                    session.init(hint);
                    let core = Core::new(
                        None,
                        Box::new(ClockAdapter { clock: session_clock, utc_offset_minutes }),
                        Box::new(SeededRng::new(1)),
                        CoreConfig { prefs_file: Some(data_dir.join("prefs.json")), system_languages: system_languages() },
                    );
                    let auth = register_ops::<SqliteStore>()
                        .into_iter()
                        .filter(|o| o.in_contract)
                        .map(|o| (o.name, (o.mutates, o.handler)))
                        .collect();
                    Worker { session, core, auth, listeners, prefs, activity, os_events }.run(rx);
                })
                .map_err(|_| AppError::failed())?
        };
        // The idle timer and the system's lock events both only send a message; the worker decides.
        {
            let tx = tx.clone();
            std::thread::spawn(move || loop {
                match stop_rx.recv_timeout(tick) {
                    Err(RecvTimeoutError::Timeout) => {
                        if tx.send(Msg::Tick).is_err() {
                            return;
                        }
                    }
                    _ => return,
                }
            });
        }
        {
            let tx = Mutex::new(tx.clone());
            os_events.on_system_lock(Box::new(move || {
                let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(Msg::SystemLock);
            }));
        }
        Ok(Self {
            tx: Mutex::new(tx),
            listeners,
            prefs,
            data_dir,
            last_activity: activity,
            worker: Mutex::new(Some(worker)),
            _ticker: stop_tx,
            _temp: temp,
        })
    }

    /// A service on a fresh database in a temporary folder with one account (password `DEMO_PASSWORD`, no 2FA, a cheap
    /// key derivation) and two accounts of the invented household; unlocked when `unlocked`. For the screenshots, the
    /// `--service core --state ...` flags and tests of the screens.
    pub fn temporary(unlocked: bool) -> Result<Self, AppError> {
        let dir = tempfile::tempdir().map_err(|_| AppError::failed())?;
        let mut options = CoreOptions::new(dir.path().to_path_buf());
        options.seal = Box::new(FileSeal::new([7; 32]));
        options.clock = Some(Arc::new(ManualClock::new(NOW_MS)));
        options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
        let service = Self::start(options, Some(dir))?;
        let call = |op: &str, input: Value| crate::block_on(service.invoke(op, input));
        call("auth.setup", json!({ "mode": "password", "password": DEMO_PASSWORD }))?;
        call(
            "accounts.create",
            json!({ "name": "Everyday account", "kind": "current", "bank": "Example Bank", "iban": "BE68 5390 0754 7034", "currency": "EUR", "openingBalanceCents": 198540 }),
        )?;
        call(
            "accounts.create",
            json!({ "name": "Savings", "kind": "savings", "bank": "Example Bank", "iban": "BE71 0961 2345 6769", "currency": "EUR", "openingBalanceCents": 1353970 }),
        )?;
        if !unlocked {
            call("auth.lock", json!({}))?;
        }
        Ok(service)
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    fn send(&self, op: String, input: Value) -> Result<Value, AppError> {
        let (reply, answer) = channel();
        self.tx.lock().unwrap_or_else(|e| e.into_inner()).send(Msg::Op(op, input, reply)).map_err(|_| AppError::failed())?;
        answer.recv().map_err(|_| AppError::failed())?
    }
}

impl Drop for CoreService {
    fn drop(&mut self) {
        // The worker locks the session (wipes the keys) and closes the database before it ends.
        let _ = self.tx.lock().unwrap_or_else(|e| e.into_inner()).send(Msg::Stop);
        if let Some(handle) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = handle.join();
        }
    }
}

impl AppService for CoreService {
    fn invoke(&self, op: &str, input: Value) -> OpFuture<'_> {
        let op = op.to_string();
        Box::pin(async move {
            // Ahead of the session: the app and preference operations.
            if op.starts_with("app.") || op.starts_with("prefs.") {
                return self.app_or_prefs(&op, input);
            }
            if op != "auth.status" {
                self.activity();
            }
            self.send(op, input)
        })
    }

    fn subscribe(&self, listener: Listener) {
        self.listeners.add(listener);
    }

    fn activity(&self) {
        *self.last_activity.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn cache_pref(&self, key: &str, value: Value) -> bool {
        self.prefs.set_key(key, Some(value));
        true
    }
}

impl CoreService {
    fn app_or_prefs(&self, op: &str, input: Value) -> Result<Value, AppError> {
        match op {
            "app.info" => Ok(json!({
                "name": "Kasboek",
                "version": env!("CARGO_PKG_VERSION"),
                "commit": "native",
                "platform": std::env::consts::OS,
                "dataDir": self.data_dir.display().to_string(),
            })),
            "app.ready" | "app.milestone" => Ok(json!({ "ok": true })),
            _ => self.prefs.dispatch(op, input),
        }
    }
}

struct Worker {
    session: Session<SqliteStore>,
    core: Core<SqliteStore>,
    auth: HashMap<&'static str, (bool, OpHandler<SqliteStore>)>,
    listeners: Arc<Listeners>,
    prefs: Arc<PrefsStore>,
    /// When the person last did something in the app.
    activity: Arc<Mutex<Instant>>,
    os_events: Arc<dyn OsEvents>,
}

impl Worker {
    fn run(mut self, rx: Receiver<Msg>) {
        while let Ok(msg) = rx.recv() {
            match msg {
                Msg::Stop => break,
                Msg::Op(op, input, reply) => {
                    let answer = self.op(&op, input);
                    let _ = reply.send(answer);
                }
                Msg::Tick => self.tick(),
                Msg::SystemLock => self.system_lock(),
            }
        }
        // The service is gone (or its channel): no key stays in memory, the database is closed.
        self.session.lock(LockReason::User, true);
        let _ = self.sync_core();
    }

    fn op(&mut self, op: &str, input: Value) -> Result<Value, AppError> {
        if let Some(refusal) = locked_refusal(op, self.session.is_unlocked()) {
            return Err(refusal);
        }
        let result = match self.auth.get(op).copied() {
            Some((mutates, handler)) => self.auth_op(op, mutates, handler, input),
            None => self.core.dispatch(op, input, Actor::User),
        };
        // `ipc.ts`: pages refresh after an operation that changed something.
        let mutates = kb_core::table::OPS.iter().any(|(n, m, _)| *n == op && *m);
        if result.is_ok() && mutates && !op.starts_with("auth.") {
            self.listeners.emit(AppEvent::DataChanged { actor: "user".into() });
        }
        result
    }

    fn progress(&self, step: LoadStep, done: u64, total: u64) {
        self.listeners.emit(AppEvent::LoadProgress { step, done, total });
    }

    fn auth_op(&mut self, op: &str, mutates: bool, handler: OpHandler<SqliteStore>, input: Value) -> Result<Value, AppError> {
        // Operations that end with an open database report the steps of the loading screen. The session opens the file
        // and migrates it in one call, so a migration step is reported as a whole (done 0 of n, then n of n).
        let opens = matches!(op, "auth.setup" | "auth.unlock" | "auth.unlockRecovery");
        let total = u64::from(SCHEMA_VERSION);
        if opens {
            self.progress(LoadStep::Opening, 0, 1);
            self.progress(LoadStep::Migrating, 0, total);
        }
        let result = handler(&mut self.session, input);
        let synced = self.sync_core();
        let result = match (result, synced) {
            (Ok(value), Ok(())) => Ok(value),
            (Ok(_), Err(e)) => {
                // The database could not be opened a second time: do not stay unlocked half way.
                self.session.lock(LockReason::User, true);
                let _ = self.sync_core();
                Err(e)
            }
            (Err(e), _) => {
                let mut error = AppError::new(&e.code, e.message);
                // A wrong try and the throttle: the Lock screen counts down from the seconds the session reports.
                let seconds = self.session.status().throttle_seconds;
                if opens && seconds > 0 {
                    error.details = Some(json!({ "throttleSeconds": seconds }));
                }
                Err(error)
            }
        };
        if result.is_ok() && opens {
            self.progress(LoadStep::Opening, 1, 1);
            self.progress(LoadStep::Migrating, total, total);
        }
        self.remember_auth();
        if result.is_ok() && mutates {
            self.listeners.emit(AppEvent::DataChanged { actor: "user".into() });
        }
        result
    }

    /// Keeps the core's database handle in step with the session: opened with the vault's key after an unlock or
    /// setup, dropped when the session is locked.
    fn sync_core(&mut self) -> Result<(), AppError> {
        let open = self.session.is_unlocked();
        if !open {
            if self.core.is_unlocked() {
                self.core.set_store(None);
                self.core.set_unlocked(false);
            }
            return Ok(());
        }
        if self.core.is_unlocked() {
            return Ok(());
        }
        let (_, _, vault) = self.session.secrets().map_err(|e| AppError::new(&e.code, e.message))?;
        let key = DbKey::from_hex(&vault.db_key)?;
        // The session migrated the file while it opened it.
        let store = SqliteStore::open(&self.session.paths().db_file, &key, OpenOptions { migrate: false })?;
        self.core.set_store(Some(store));
        self.core.set_unlocked(true);
        Ok(())
    }

    /// The facts the Lock screen of the next start is drawn from (`lastAuth` in prefs.json).
    fn remember_auth(&mut self) {
        let status = self.session.status();
        let value = (status.state != "setup").then(|| {
            json!({ "mode": status.mode, "device": status.device, "twoFactor": status.two_factor, "rememberedUntil": status.remembered_until })
        });
        self.prefs.set_key("lastAuth", value);
    }

    fn tick(&mut self) {
        if !self.session.is_unlocked() {
            return;
        }
        // The system's idle time when it can tell; else the time since the person last did something in the app.
        let idle =
            self.os_events.idle_seconds().unwrap_or_else(|| self.activity.lock().unwrap_or_else(|e| e.into_inner()).elapsed().as_secs());
        self.session.auto_lock_tick(idle, self.prefs.auto_lock_minutes());
        let _ = self.sync_core();
    }

    fn system_lock(&mut self) {
        self.session.on_system_lock();
        let _ = self.sync_core();
    }
}

/// The QR code of `auth.totpBegin` as an SVG document, from the `otpauth://` URI.
fn qr_svg(uri: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(uri.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(200, 200)
                .quiet_zone(true)
                .dark_color(svg::Color("#000000"))
                .light_color(svg::Color("#ffffff"))
                .build()
        })
        .unwrap_or_default()
}
