//! `CoreService`: operations run through `kb_core::dispatch` on a real encrypted database in a temporary folder. The
//! core is not `Sync`, so one worker thread owns it (the "one DB worker" of the plan) and requests travel to it over a
//! channel. Login is a stand-in (`DEMO_PASSWORD`, no 2FA, no throttle) until `kb-session` is wired in; everything the
//! core has not ported answers `op.not_ported` from `dispatch` itself.
use crate::{AppError, AppEvent, AppService, Listener, Listeners, OpFuture, DEMO_PASSWORD};
use kb_core::{Actor, Core, CoreConfig, FixedClock, SeededRng};
use kb_db::{DbKey, OpenOptions, SqliteStore, Store};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

type Reply = Sender<Result<Value, AppError>>;

pub struct CoreService {
    tx: Mutex<Sender<(String, Value, Reply)>>,
    listeners: Arc<Listeners>,
    // Keeps the temporary folder alive; it is deleted when the service is dropped.
    _dir: tempfile::TempDir,
}

/// 2026-11-14T10:00:00Z, the day of the invented household.
const NOW_MS: i64 = 1_794_650_400_000;

impl CoreService {
    /// A fresh database (key from a fixed test value) with two accounts of the invented
    /// household (the default categories come with a new database), locked. `unlocked` starts it unlocked, for tests.
    pub fn temporary(unlocked: bool) -> Result<Self, AppError> {
        let dir = tempfile::tempdir().map_err(|_| AppError::failed())?;
        let path = dir.path().to_path_buf();
        let listeners = Arc::new(Listeners::default());
        let (tx, rx) = channel::<(String, Value, Reply)>();
        let (ready_tx, ready_rx) = channel::<Result<(), AppError>>();
        std::thread::spawn(move || {
            let built = (|| -> Result<Core<SqliteStore>, AppError> {
                let key = DbKey::from_hex(&"a1".repeat(32))?;
                let store = SqliteStore::open(&path.join("kasboek.db"), &key, OpenOptions::default())?;
                let core = Core::new(
                    Some(store),
                    Box::new(FixedClock { ms: NOW_MS, utc_offset_minutes: 0 }),
                    Box::new(SeededRng::new(1)),
                    CoreConfig { prefs_file: Some(path.join("prefs.json")), system_languages: vec!["en".into()] },
                );
                seed(&core)?;
                Ok(core)
            })();
            let mut core = match built {
                Ok(c) => {
                    let _ = ready_tx.send(Ok(()));
                    c
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            core.set_unlocked(unlocked);
            let mut state = if unlocked { "unlocked" } else { "locked" };
            while let Ok((op, input, reply)) = rx.recv() {
                let answer = match op.as_str() {
                    "auth.status" => Ok(status(state)),
                    "auth.unlock" if input["password"].as_str() == Some(DEMO_PASSWORD) => {
                        state = "unlocked";
                        core.set_unlocked(true);
                        Ok(status(state))
                    }
                    "auth.unlock" => Err(AppError::new("auth.wrong_password", "That password is wrong.")),
                    "auth.lock" => {
                        state = "locked";
                        core.set_unlocked(false);
                        Ok(status(state))
                    }
                    _ => core.dispatch(&op, input, Actor::User),
                };
                let _ = reply.send(answer);
            }
        });
        ready_rx.recv().map_err(|_| AppError::failed())??;
        Ok(Self { tx: Mutex::new(tx), listeners, _dir: dir })
    }
}

fn status(state: &str) -> Value {
    json!({ "state": state, "mode": "password", "twoFactor": false, "rememberedUntil": null, "device": null, "deviceChecking": false,
            "throttleSeconds": 0, "recovered": false, "weakPassword": false, "legacyData": false, "erased": [], "keyProtection": "os", "error": null })
}

fn seed(core: &Core<SqliteStore>) -> Result<(), AppError> {
    let run = |op: &str, input: Value| core.dispatch(op, input, Actor::System);
    run(
        "accounts.create",
        json!({ "name": "Everyday account", "kind": "current", "bank": "Example Bank", "iban": "BE68 5390 0754 7034", "currency": "EUR", "openingBalanceCents": 198540 }),
    )?;
    run(
        "accounts.create",
        json!({ "name": "Savings", "kind": "savings", "bank": "Example Bank", "iban": "BE71 0961 2345 6769", "currency": "EUR", "openingBalanceCents": 1353970 }),
    )?;
    Ok(())
}

impl AppService for CoreService {
    fn invoke(&self, op: &str, input: Value) -> OpFuture<'_> {
        let op = op.to_string();
        Box::pin(async move {
            let mutates = kb_core::table::OPS.iter().any(|(n, m, _)| *n == op && *m);
            let (reply, answer) = channel();
            self.tx.lock().unwrap_or_else(|e| e.into_inner()).send((op, input, reply)).map_err(|_| AppError::failed())?;
            let result = answer.recv().map_err(|_| AppError::failed())?;
            if result.is_ok() && mutates {
                self.listeners.emit(AppEvent::DataChanged { actor: "user".into() });
            }
            result
        })
    }

    fn subscribe(&self, listener: Listener) {
        self.listeners.add(listener);
    }
}
