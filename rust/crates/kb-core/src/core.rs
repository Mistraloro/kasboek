//! `Core`: the state the operations run against, and `dispatch`, the one entry point (`dispatch` in src/main/ipc.ts and
//! `runOp` in src/core/ops.ts).
use crate::clock::{Clock, Rng};
use crate::error::{AppError, AppResult};
use crate::numbers;
use crate::ops;
use crate::prefs::PrefsFile;
use crate::recurring::RecurringSummary;
use crate::table::{OPS, PUBLIC_OPS};
use kb_db::Store;
use serde_json::Value;
use std::cell::RefCell;
use std::path::PathBuf;

/// Who asks: the person, the assistant (in-app or MCP), or Kasboek itself. Stored in the audit log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    User,
    Assistant,
    System,
}

impl Actor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

/// What an operation hands back to `dispatch`: its result and the parsed input, which the audit log keeps.
pub struct Done {
    pub data: Value,
    pub audit: Value,
}

pub struct Core<S: Store> {
    store: Option<S>,
    unlocked: bool,
    pub(crate) clock: Box<dyn Clock>,
    /// For the operations that need ids of their own (the key of a transfer pair).
    pub(crate) rng: Box<dyn Rng>,
    pub(crate) prefs: RefCell<PrefsFile>,
    /// The last recurring-payments scan: `(day and change count it was made for, result)`.
    pub(crate) recurring_cache: RefCell<Option<(String, RecurringSummary)>>,
}

pub struct CoreConfig {
    /// Where `prefs.json` is (None: no file; reading gives the defaults and writing fails).
    pub prefs_file: Option<PathBuf>,
    /// The system's preferred languages, for the first start (`app.getPreferredSystemLanguages()`).
    pub system_languages: Vec<String>,
}

impl<S: Store> Core<S> {
    /// A core over an open database, unlocked.
    pub fn new(store: Option<S>, clock: Box<dyn Clock>, rng: Box<dyn Rng>, config: CoreConfig) -> Self {
        Self {
            unlocked: store.is_some(),
            store,
            clock,
            rng,
            prefs: RefCell::new(PrefsFile::new(config.prefs_file, config.system_languages)),
            recurring_cache: RefCell::new(None),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
    }

    /// Lock or unlock without touching the database handle (the session owns that in the app).
    pub fn set_unlocked(&mut self, unlocked: bool) {
        self.unlocked = unlocked;
    }

    pub fn set_store(&mut self, store: Option<S>) {
        self.store = store;
        self.recurring_cache = RefCell::new(None);
    }

    /// The database, or `auth.locked` when there is none (`session.db()`).
    pub fn db(&self) -> AppResult<&S> {
        self.store.as_ref().ok_or_else(AppError::locked)
    }

    pub fn today(&self) -> String {
        self.clock.local_today()
    }

    pub fn dispatch(&self, op: &str, input: Value, actor: Actor) -> Result<Value, AppError> {
        dispatch(self, op, input, actor)
    }
}

/// The refusal for an operation that needs a login, or `None` when it may run: only the login operations work while locked.
pub fn locked_refusal(op: &str, unlocked: bool) -> Option<AppError> {
    (!unlocked && !PUBLIC_OPS.contains(&op)).then(AppError::locked)
}

/// Never store secrets in the audit log.
fn redacted(op: &str) -> bool {
    ["auth.", "transfer.", "backup.", "prefs.", "insights."].iter().any(|p| op.starts_with(p))
}

/// Runs an operation: refuses it while locked (unless it is a login operation), validates the input, runs it and records
/// changes in the audit log. Operations of the contract that are not ported yet answer `op.not_ported`.
pub fn dispatch<S: Store>(core: &Core<S>, op: &str, input: Value, actor: Actor) -> Result<Value, AppError> {
    if let Some(refusal) = locked_refusal(op, core.is_unlocked()) {
        return Err(refusal);
    }
    let Some(&(name, mutates, _)) = OPS.iter().find(|(n, _, _)| *n == op) else {
        return Err(AppError::new("op.unknown", format!("Unknown operation: {op}")));
    };
    let Some(handler) = ops::handler::<S>(name) else {
        return Err(AppError::new("op.not_ported", format!("The operation {name} is not ported to the native app yet.")));
    };
    let Done { mut data, mut audit } = handler(core, input)?;
    if mutates {
        let details = if redacted(name) {
            "{}".to_owned()
        } else {
            numbers::normalize(&mut audit);
            audit.to_string()
        };
        match core.db().and_then(|db| Ok(db.audit_insert(actor.as_str(), name, &details)?)) {
            Ok(()) => {}
            // Locked (e.g. right after "erase"): nothing to log into.
            Err(e) if e.code == "auth.locked" => {}
            Err(_) => return Err(AppError::failed()),
        }
    }
    numbers::normalize(&mut data);
    Ok(data)
}
