//! `FixtureService`: answers from JSON files (the invented household; see rust/apps/kasboek/fixtures) and keeps a small
//! login state so that the Lock and Setup screens can be tried: the password is [`DEMO_PASSWORD`].
use crate::{not_ported, AppError, AppEvent, AppService, Listener, Listeners, LoadStep, OpFuture};
use serde_json::{json, Map, Value};
use std::sync::Mutex;
use std::time::Duration;

pub const DEMO_PASSWORD: &str = "correct horse battery 12";

#[derive(Debug, Clone)]
pub struct FixtureConfig {
    /// "setup", "locked" or "unlocked".
    pub state: String,
    /// "password" or "device".
    pub mode: String,
    /// "windows-hello", "touch-id" or None.
    pub device: Option<String>,
    /// Pretend the key derivation takes this long (the real one is about 300 ms).
    pub unlock_delay: Duration,
    /// Pause between the steps of the loading screen, so that it can be seen (zero: none).
    pub step_delay: Duration,
}

impl Default for FixtureConfig {
    fn default() -> Self {
        Self {
            state: "locked".into(),
            mode: "password".into(),
            device: None,
            unlock_delay: Duration::from_millis(300),
            step_delay: Duration::ZERO,
        }
    }
}

struct State {
    status: Value,
    failures: u32,
}

pub struct FixtureService {
    answers: Map<String, Value>,
    summary_month: Map<String, Value>,
    budgets: Map<String, Value>,
    config: FixtureConfig,
    state: Mutex<State>,
    listeners: Listeners,
}

impl FixtureService {
    /// `answers`, `summaryMonth` and `budgets` as written by rust/apps/kasboek/tools/gen-fixtures.mjs.
    pub fn from_json(fixtures: &str, config: FixtureConfig) -> Result<Self, serde_json::Error> {
        let mut root: Map<String, Value> = serde_json::from_str(fixtures)?;
        let mut take = |k: &str| match root.remove(k) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let (answers, summary_month, budgets) = (take("answers"), take("summaryMonth"), take("budgets"));
        let mut status = answers.get("auth.status").cloned().unwrap_or_else(|| json!({}));
        status["state"] = json!(config.state);
        status["mode"] = json!(if config.state == "setup" { Value::Null } else { json!(config.mode) });
        status["device"] = json!(config.device);
        Ok(Self {
            answers,
            summary_month,
            budgets,
            config,
            state: Mutex::new(State { status, failures: 0 }),
            listeners: Listeners::default(),
        })
    }

    /// The fixtures committed with the app.
    pub fn bundled(config: FixtureConfig) -> Self {
        Self::from_json(include_str!("../../../apps/kasboek/fixtures/household.json"), config).expect("bundled fixtures")
    }

    fn status(&self) -> Value {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).status.clone()
    }

    fn set_state(&self, state: &str) -> Value {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.status["state"] = json!(state);
        s.status["throttleSeconds"] = json!(0);
        s.status.clone()
    }

    fn unlocked(&self) -> bool {
        self.status()["state"] == "unlocked"
    }

    /// The work of opening the database and migrating it, simulated; the app reports the loading of the Overview itself.
    fn progress(&self) {
        for (step, total) in [(LoadStep::Opening, 1), (LoadStep::Migrating, 3)] {
            for done in 0..=total {
                self.listeners.emit(AppEvent::LoadProgress { step, done, total });
                std::thread::sleep(self.config.step_delay);
            }
        }
    }

    fn auth(&self, op: &str, input: &Value) -> Result<Value, AppError> {
        match op {
            "auth.status" => Ok(self.status()),
            "auth.unlock" => {
                std::thread::sleep(self.config.unlock_delay);
                let device = self.status()["mode"] == "device";
                let ok = device || input["password"].as_str() == Some(DEMO_PASSWORD);
                if !ok {
                    let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    s.failures += 1;
                    if s.failures >= 3 {
                        s.status["throttleSeconds"] = json!(5 * (s.failures - 2));
                    }
                    return Err(AppError::new("auth.wrong_password", "That password is wrong."));
                }
                self.state.lock().unwrap_or_else(|e| e.into_inner()).failures = 0;
                self.progress();
                Ok(self.set_state("unlocked"))
            }
            "auth.lock" => {
                let status = self.set_state("locked");
                self.listeners.emit(AppEvent::Locked { reason: "user".into() });
                Ok(status)
            }
            "auth.setup" => {
                if input["mode"] == "password" && input["password"].as_str().is_none_or(|p| !kb_rules_ok(p)) {
                    return Err(AppError::new("auth.weak_password", "That password is too weak."));
                }
                {
                    let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    s.status["mode"] = input["mode"].clone();
                }
                self.set_state("unlocked");
                Ok(json!({ "recoveryKey": "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789" }))
            }
            _ => Err(not_ported(op)),
        }
    }
}

/// The main process refuses what the rules refuse; the fixture applies the same length rule only (the screens run the
/// full rules live), so that a test password of the right length passes.
fn kb_rules_ok(password: &str) -> bool {
    password.chars().count() >= 12
}

impl AppService for FixtureService {
    fn invoke(&self, op: &str, input: Value) -> OpFuture<'_> {
        let op = op.to_string();
        Box::pin(async move {
            if op.starts_with("auth.") && op != "auth.unlockRecovery" && op != "auth.forgetComputer" {
                return self.auth(&op, &input);
            }
            if !self.unlocked() {
                return Err(AppError::locked());
            }
            let month = input["month"].as_str().unwrap_or_default();
            match op.as_str() {
                "summary.month" => {
                    self.summary_month.get(month).cloned().ok_or_else(|| AppError::new("op.not_found", "No data for that month."))
                }
                "budgets.list" => self.budgets.get(month).cloned().ok_or_else(|| AppError::new("op.not_found", "No data for that month.")),
                other => self.answers.get(other).cloned().ok_or_else(|| not_ported(other)),
            }
        })
    }

    fn subscribe(&self, listener: Listener) {
        self.listeners.add(listener);
    }
}
