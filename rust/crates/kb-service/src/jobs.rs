//! Job threads: how service operations (dialogs, files, network, child processes; `ops/`) run. They never run on the database
//! worker, which would freeze every other operation while a dialog is open or a PDF is read. Each call gets its own thread and
//! a [`JobCtx`]; the context hands closures to the worker when the operation needs the database ([`JobCtx::with_core`]),
//! carries the [`Cancel`] flag that the lock sets (`cancelRunningJobs` in the TypeScript app), and the desktop and the
//! network of the app.
use crate::backup_scheduler::BackupScheduler;
use crate::core_service::Worker;
use crate::desktop::Desktop;
use crate::http::Http;
use crate::{AppError, AppEvent, Listeners};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

/// A flag that a running job looks at now and then. Cloning shares the flag.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Whether both are the same flag (a clone of each other).
    pub(crate) fn is_same(&self, other: &Cancel) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// `Err(job.cancelled)` once cancelled, for `?` between the steps of a job.
    pub fn check(&self) -> Result<(), AppError> {
        if self.is_cancelled() {
            Err(AppError::new("job.cancelled", "The job was cancelled."))
        } else {
            Ok(())
        }
    }
}

/// A service operation: runs on a job thread, with the context of the call and the operation's input.
pub type ServiceHandler = fn(&JobCtx, Value) -> Result<Value, AppError>;

/// The service operations by name. `ops::table()` fills it from the area files; a test may add its own.
#[derive(Clone, Default)]
pub struct ServiceTable {
    ops: Vec<(&'static str, ServiceHandler)>,
}

impl ServiceTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an operation. A name twice is a programming error (two areas claiming one operation).
    pub fn add(&mut self, name: &'static str, handler: ServiceHandler) -> &mut Self {
        assert!(self.get(name).is_none(), "service operation {name} is registered twice");
        self.ops.push((name, handler));
        self
    }

    pub fn get(&self, name: &str) -> Option<ServiceHandler> {
        self.ops.iter().find(|(n, _)| *n == name).map(|(_, h)| *h)
    }

    pub fn names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.ops.iter().map(|(n, _)| *n)
    }
}

/// Work for the database worker.
pub(crate) type CoreJob = Box<dyn FnOnce(&mut Worker) + Send>;

/// The running jobs, so that the lock can cancel them all.
#[derive(Default)]
pub(crate) struct Jobs {
    next: AtomicU64,
    running: Mutex<Vec<(u64, Cancel)>>,
}

impl Jobs {
    /// Registers a job; it stays registered until the guard is dropped. Register before looking at the lock state, so a lock in
    /// between cancels the job.
    pub(crate) fn start(self: &Arc<Self>) -> (JobGuard, Cancel) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let cancel = Cancel::new();
        self.running.lock().unwrap_or_else(|e| e.into_inner()).push((id, cancel.clone()));
        (JobGuard { jobs: self.clone(), id }, cancel)
    }

    pub(crate) fn cancel_all(&self) {
        for (_, cancel) in self.running.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            cancel.cancel();
        }
    }

    /// Cancels every job but `keep` (the one that replaces the database and must go on).
    pub(crate) fn cancel_all_except(&self, keep: &Cancel) {
        for (_, cancel) in self.running.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if !cancel.is_same(keep) {
                cancel.cancel();
            }
        }
    }
}

pub(crate) struct JobGuard {
    jobs: Arc<Jobs>,
    id: u64,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.jobs.running.lock().unwrap_or_else(|e| e.into_inner()).retain(|(id, _)| *id != self.id);
    }
}

/// What a service operation can use. One per call.
pub struct JobCtx {
    cancel: Cancel,
    desktop: Arc<dyn Desktop>,
    http: Arc<dyn Http>,
    listeners: Arc<Listeners>,
    /// Queues work on the database worker; `false` when the worker has ended.
    submit: Arc<dyn Fn(CoreJob) -> bool + Send + Sync>,
    backups: BackupScheduler,
}

impl JobCtx {
    pub(crate) fn new(
        cancel: Cancel,
        desktop: Arc<dyn Desktop>,
        http: Arc<dyn Http>,
        listeners: Arc<Listeners>,
        submit: Arc<dyn Fn(CoreJob) -> bool + Send + Sync>,
        backups: BackupScheduler,
    ) -> Self {
        Self { cancel, desktop, http, listeners, submit, backups }
    }

    /// Runs `f` on the database worker (which owns the session and the core) and waits for its answer. Keep `f` short: the
    /// worker serves nothing else meanwhile. Gives up with `job.cancelled` once the job is cancelled, and with `op.failed`
    /// when the worker has ended.
    pub fn with_core<R: Send + 'static>(&self, f: impl FnOnce(&mut Worker) -> R + Send + 'static) -> Result<R, AppError> {
        self.cancel.check()?;
        let (reply, answer) = channel();
        let job: CoreJob = Box::new(move |worker| {
            let _ = reply.send(f(worker));
        });
        if !(self.submit)(job) {
            return Err(AppError::failed());
        }
        // A job the ended worker dropped unrun closes the channel.
        answer.recv().map_err(|_| AppError::failed())
    }

    /// Tells the listeners (the screens) something happened, from this thread.
    pub fn emit(&self, event: AppEvent) {
        self.listeners.emit(event);
    }

    /// Set when the lock (or the person) cancelled this job: look at it between steps and pass it to the network calls.
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }

    pub fn desktop(&self) -> &dyn Desktop {
        &*self.desktop
    }

    pub fn http(&self) -> &dyn Http {
        &*self.http
    }

    /// The automatic backups (the scheduler of `backup_scheduler.rs`).
    pub(crate) fn backups(&self) -> &BackupScheduler {
        &self.backups
    }
}
