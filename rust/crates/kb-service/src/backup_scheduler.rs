//! When automatic backups happen (src/main/transfer/scheduler.ts):
//!   - a few seconds after an important change (import, undo, restore, bulk edits),
//!   - at most once an hour after other changes,
//!   - once a day regardless,
//!   - and right before Kasboek locks or quits, if anything changed since the last backup.
//!
//! One thread per login does the waiting; it ends when the app locks (the generation counter moves on), and the backup it
//! runs is a job, so the lock cancels it too. The service tells the scheduler about changes, unlocks and locks.
use crate::desktop::Desktop;
use crate::http::Http;
use crate::jobs::{CoreJob, JobCtx, Jobs};
use crate::ops::{run_auto_backup_if_due, run_auto_backup_sync, OsZone};
use crate::{AppEvent, Listeners, Worker};
use kb_core::backup_tiers::LocalZone;
use serde_json::Value;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const IMPORTANT: [&str; 5] = ["import.commit", "import.undo", "transfer.import", "transactions.delete", "budgets.copyPrevious"];
const HOURLY: Duration = Duration::from_secs(3600);

/// The waits of the scheduler. The real ones are the defaults; a test shortens them.
#[derive(Debug, Clone, Copy)]
pub struct BackupTiming {
    /// After the app starts or unlocks: the first check.
    pub start: Duration,
    /// After an important change.
    pub soon: Duration,
    /// After another change, when the last backup is over an hour old.
    pub after_change: Duration,
    /// Between the regular checks.
    pub check: Duration,
}

impl Default for BackupTiming {
    fn default() -> Self {
        Self {
            start: Duration::from_secs(15),
            soon: Duration::from_secs(5),
            after_change: Duration::from_secs(60),
            check: Duration::from_secs(3600),
        }
    }
}

/// How a thread reaches the database worker and the app.
pub(crate) struct Env {
    pub jobs: Arc<Jobs>,
    pub desktop: Arc<dyn Desktop>,
    pub http: Arc<dyn Http>,
    pub listeners: Arc<Listeners>,
    pub submit: Arc<dyn Fn(CoreJob) -> bool + Send + Sync>,
    pub zone: Arc<dyn LocalZone>,
    pub timing: BackupTiming,
}

#[derive(Default)]
struct State {
    /// Something changed since the last backup.
    dirty: bool,
    /// When the scheduler last made a backup.
    last_run: Option<Instant>,
    /// The thread of this login ends once the generation has moved on.
    generation: u64,
    running: bool,
    start_at: Option<Instant>,
    soon_at: Option<Instant>,
    check_at: Option<Instant>,
}

struct Inner {
    env: Env,
    state: Mutex<State>,
    wake: Condvar,
}

#[derive(Clone)]
pub struct BackupScheduler(Arc<Inner>);

enum Action {
    /// `runAutoBackupIfDue(24)`.
    Daily,
    /// `runAutoBackupIfDue(0)`.
    Now,
}

impl BackupScheduler {
    pub(crate) fn new(env: Env) -> Self {
        Self(Arc::new(Inner { env, state: Mutex::new(State::default()), wake: Condvar::new() }))
    }

    /// The time zone of the computer, for file names.
    pub(crate) fn zone(&self) -> &dyn LocalZone {
        &*self.0.env.zone
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a change is one that deserves a backup soon: an import, undo, restore or a bulk edit. Read from the operation
    /// and its input before the input is handed on (it may hold secrets, which this never copies).
    pub(crate) fn is_important(op: &str, input: &Value) -> bool {
        let ids = input.get("ids").and_then(Value::as_array);
        let bulk = op == "transactions.categorize" && ids.is_some_and(|ids| ids.len() >= 10);
        let rules = op == "rules.create" && input.get("applyToExisting") != Some(&Value::Bool(false));
        IMPORTANT.contains(&op) || bulk || rules
    }

    /// Called after every successful change to the data (`dataChanged`).
    pub(crate) fn data_changed(&self, important: bool) {
        let timing = self.0.env.timing;
        let mut state = self.state();
        state.dirty = true;
        if important {
            state.soon_at = Some(Instant::now() + timing.soon);
        } else if state.last_run.is_none_or(|t| t.elapsed() > HOURLY) {
            state.soon_at = Some(Instant::now() + timing.after_change);
        }
        self.ensure_running(&mut state);
        self.0.wake.notify_all();
    }

    /// The person logged in: the first check comes shortly (`unlocked`).
    pub(crate) fn unlocked(&self) {
        let mut state = self.state();
        self.ensure_running(&mut state);
        state.start_at = Some(Instant::now() + self.0.env.timing.start);
        self.0.wake.notify_all();
    }

    /// The app locked or the service ends: the thread of this login ends.
    pub(crate) fn stop(&self) {
        let mut state = self.state();
        state.generation += 1;
        state.running = false;
        state.start_at = None;
        state.soon_at = None;
        state.check_at = None;
        self.0.wake.notify_all();
    }

    /// Last chance before the database closes (lock, auto-lock, quit): a backup if anything changed since the last one. Runs
    /// on the database worker, with the database still open.
    pub(crate) fn before_lock(&self, worker: &mut Worker) {
        if !self.state().dirty {
            return;
        }
        match run_auto_backup_sync(worker, &*self.0.env.zone) {
            Ok(Some(_)) => {
                let mut state = self.state();
                state.dirty = false;
                state.last_run = Some(Instant::now());
            }
            Ok(None) => {}
            Err(e) => eprintln!("[backup] before lock failed: {}", e.code),
        }
    }

    /// `notifyBackup(runAutoBackupIfDue())`: after the person switched automatic backups on, make the first backup straight
    /// away, on a job of its own, and tell the screens how it went.
    pub(crate) fn run_if_due_now(&self) {
        let this = self.clone();
        let spawned = std::thread::Builder::new().name("kb-backup".into()).spawn(move || {
            if let Ok(Some(file)) = this.run(&Action::Daily) {
                this.0.env.listeners.emit(AppEvent::BackupCompleted { file });
            }
        });
        drop(spawned);
    }

    fn ensure_running(&self, state: &mut State) {
        if state.running {
            return;
        }
        state.running = true;
        state.generation += 1;
        state.check_at = Some(Instant::now() + self.0.env.timing.check);
        let (this, generation) = (self.clone(), state.generation);
        if std::thread::Builder::new().name("kb-backup-scheduler".into()).spawn(move || this.wait_and_run(generation)).is_err() {
            state.running = false;
        }
    }

    /// Runs one check as a job (the lock cancels it). `Ok(None)`: nothing was due, or the backup was cancelled.
    fn run(&self, action: &Action) -> Result<Option<String>, ()> {
        let env = &self.0.env;
        let (_guard, cancel) = env.jobs.start();
        let ctx = JobCtx::new(cancel, env.desktop.clone(), env.http.clone(), env.listeners.clone(), env.submit.clone(), self.clone());
        let max_age = match action {
            Action::Daily => 24,
            Action::Now => 0,
        };
        match run_auto_backup_if_due(&ctx, &*env.zone, max_age) {
            Ok(file) => Ok(file),
            // The lock (or the end of the service) cancelled it: nothing to report.
            Err(e) if e.code == "job.cancelled" || e.code == "op.failed" && ctx.cancel().is_cancelled() => Err(()),
            Err(e) => {
                env.listeners.emit(AppEvent::BackupFailed { message: e.message });
                Err(())
            }
        }
    }

    fn wait_and_run(&self, generation: u64) {
        let timing = self.0.env.timing;
        let mut state = self.state();
        loop {
            if state.generation != generation {
                return;
            }
            let due = [(state.start_at, 0), (state.soon_at, 1), (state.check_at, 2)]
                .into_iter()
                .filter_map(|(at, which)| at.map(|at| (at, which)))
                .min();
            let Some((at, which)) = due else {
                state = self.0.wake.wait(state).unwrap_or_else(|e| e.into_inner());
                continue;
            };
            let now = Instant::now();
            if at > now {
                state = self.0.wake.wait_timeout(state, at - now).unwrap_or_else(|e| e.into_inner()).0;
                continue;
            }
            let action = match which {
                0 => {
                    state.start_at = None;
                    Some(Action::Daily)
                }
                1 => {
                    state.soon_at = None;
                    state.dirty.then_some(Action::Now)
                }
                _ => {
                    state.check_at = Some(now + timing.check);
                    // Changed and the last backup is over an hour old: soon, else the daily check.
                    let stale = state.last_run.is_none_or(|t| t.elapsed() > HOURLY);
                    if state.dirty && stale {
                        state.soon_at = Some(now);
                        None
                    } else {
                        Some(Action::Daily)
                    }
                }
            };
            let Some(action) = action else { continue };
            drop(state);
            let done = self.run(&action);
            state = self.state();
            if let (Ok(Some(file)), true) = (done, state.generation == generation) {
                state.dirty = false;
                state.last_run = Some(Instant::now());
                self.0.env.listeners.emit(AppEvent::BackupCompleted { file });
            }
        }
    }
}

/// The time zone the app uses unless a test sets its own.
pub(crate) fn os_zone() -> Arc<dyn LocalZone> {
    Arc::new(OsZone)
}
