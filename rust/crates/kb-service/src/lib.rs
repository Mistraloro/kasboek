//! `AppService`: what the native screens talk to. It mirrors the renderer's bridge (`KasboekBridge` in
//! src/shared/contract.ts): `invoke(op, input)` answers with the operation's JSON output or an [`AppError`], and
//! listeners get [`AppEvent`]s. [`FixtureService`] answers from JSON fixtures (the invented household of the release
//! screenshots), [`CoreService`] runs `kb_core::dispatch` on a real encrypted temporary database. The login operations
//! of both are stand-ins until `kb-session` is wired in. Operations the core has not ported answer `op.not_ported`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

mod core_service;
mod exec;
mod fixture;

pub use core_service::CoreService;
pub use exec::block_on;
pub use fixture::{FixtureConfig, FixtureService, DEMO_PASSWORD};
pub use kb_core::AppError;

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
