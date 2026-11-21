//! `AppService`: what the native screens talk to. It mirrors the renderer's bridge (`KasboekBridge` in
//! src/shared/contract.ts): `invoke(op, input)` answers with the operation's JSON output or an [`AppError`], and
//! listeners get [`AppEvent`]s. [`FixtureService`] answers from JSON fixtures (the invented household of the release
//! screenshots), [`CoreService`] owns a `kb-session` `Session` and a `kb-core` `Core` on the real data folder: the
//! `auth.*` operations and all ported operations, with the dispatch rules of `ipc.ts`. The login operations of the
//! fixture are stand-ins. Operations the core has not ported answer `op.not_ported`. Desktop operations (`ops/`) run on job
//! threads of their own (`jobs.rs`), with the app's [`Desktop`] and [`Http`].
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

mod backup_scheduler;
mod core_service;
mod desktop;
mod exec;
mod fixture;
mod http;
mod jobs;
mod ops;
mod paths;
mod prefs_store;

pub use backup_scheduler::BackupTiming;
pub use core_service::{ClockAdapter, CoreOptions, CoreService, NoOsEvents, OsEvents, Worker};
pub use desktop::{Desktop, DesktopCall, FakeDesktop, Filter, NoDesktop};
pub use exec::block_on;
pub use fixture::{FixtureConfig, FixtureService, DEMO_PASSWORD};
pub use http::{FakeHttp, Http, HttpError, HttpRequest, HttpResponse, NoHttp, Recorded, UreqHttp, DEFAULT_MAX_BODY};
pub use jobs::{Cancel, JobCtx, ServiceHandler, ServiceTable};
pub use kb_core::AppError;
pub use ops::{table as service_table, OsZone, SERVICE_OPS};
pub use paths::resolve_data_dir;

/// Whether the operating system can seal the account file of `data_dir` (Windows DPAPI, macOS Keychain, a Secret Service
/// on Linux). Asking never prompts. The Electron data folder is only opened by default when this is true.
pub fn os_seal_available(data_dir: &std::path::Path) -> bool {
    kb_oseal::select_os_seal_for(data_dir).available()
}
pub use prefs_store::update_prefs_key;

pub type OpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, AppError>> + Send + 'a>>;

/// The steps of the loading screen (section 5 of the plan); each has a fixed share of the bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoadStep {
    Opening,
    Migrating,
    Transactions,
    Overview,
}

impl LoadStep {
    /// The key of its text in the locale files (`loading.*`).
    pub fn key(self) -> &'static str {
        match self {
            Self::Opening => "loading.opening",
            Self::Migrating => "loading.migrating",
            Self::Transactions => "loading.transactions",
            Self::Overview => "loading.overview",
        }
    }
}

/// `AppEvent` of src/shared/contract.ts (the ones a screen of the first slice needs; the rest carry their JSON), plus
/// `LoadProgress` from the plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AppEvent {
    #[serde(rename = "data.changed")]
    DataChanged { actor: String },
    #[serde(rename = "auth.refresh")]
    AuthRefresh,
    #[serde(rename = "auth.locked")]
    Locked { reason: String },
    #[serde(rename = "settings.changed")]
    SettingsChanged,
    #[serde(rename = "backup.completed")]
    BackupCompleted { file: String },
    #[serde(rename = "backup.failed")]
    BackupFailed { message: String },
    #[serde(rename = "insights.updated")]
    InsightsUpdated { month: String },
    #[serde(rename = "load.progress")]
    LoadProgress { step: LoadStep, done: u64, total: u64 },
    /// Any other event of the contract, as the bridge would send it.
    #[serde(untagged)]
    Other(Value),
}

pub type Listener = Arc<dyn Fn(AppEvent) + Send + Sync>;

pub trait AppService: Send + Sync {
    /// Runs an operation by its contract name. The future may block its thread (the screens run it off the UI thread).
    fn invoke(&self, op: &str, input: Value) -> OpFuture<'_>;
    /// Registers a listener. It is called from whatever thread raises the event.
    fn subscribe(&self, listener: Listener);
    /// The person did something in the window (keeps the idle timer of the auto-lock from running). Nothing by default.
    fn activity(&self) {}
    /// Stores a value in `prefs.json` that is not a preference of the contract (the app's own caches: `lastAuth`,
    /// `lastTheme`). `true` when this service wrote it; `false` leaves the writing to the caller.
    fn cache_pref(&self, _key: &str, _value: Value) -> bool {
        false
    }
    /// Ends the service's own threads (and closes its database) before the process ends, waiting at most `timeout`; `true`
    /// when everything has ended. Called once by the app after the event loop, so that no destructor has to join a thread
    /// at process exit (on Windows other threads are already gone then). Nothing to do by default.
    fn shutdown(&self, _timeout: Duration) -> bool {
        true
    }
}

/// `op.not_ported`: the same code kb-core answers for an operation of the contract it does not have yet.
pub fn not_ported(op: &str) -> AppError {
    AppError::new("op.not_ported", format!("{op} is not ported to the native app yet."))
}

/// The listeners of a service.
#[derive(Default)]
pub(crate) struct Listeners(std::sync::Mutex<Vec<Listener>>);

impl Listeners {
    pub(crate) fn add(&self, l: Listener) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(l);
    }
    pub(crate) fn emit(&self, e: AppEvent) {
        let all: Vec<Listener> = self.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for l in all {
            l(e.clone());
        }
    }
}
