//! Service operations on job threads (`jobs.rs`): off the database worker, cancelled by the lock, refused while locked, and
//! never in the way of a core operation. The fakes of the desktop and the network.
use kb_crypto::slot::Argon2Cost;
use kb_service::{
    block_on, AppError, AppService, Cancel, CoreOptions, CoreService, Desktop, DesktopCall, FakeDesktop, FakeHttp, Http, HttpError,
    HttpRequest, JobCtx, NoDesktop, Recorded, ServiceTable,
};
use kb_session::seal::FileSeal;
use kb_session::time::ManualClock;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PASSWORD: &str = "Tulip-Harbour-Lantern-48";

/// An unlocked service on a temporary folder with the given extra service operations.
fn service(add: impl FnOnce(&mut ServiceTable)) -> (CoreService, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut options = CoreOptions::new(dir.path().to_path_buf());
    options.seal = Box::new(FileSeal::new([3; 32]));
    options.clock = Some(Arc::new(ManualClock::new(1_794_650_400_000)));
    options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
    add(&mut options.service_ops);
    let service = CoreService::open(options).unwrap();
    block_on(service.invoke("auth.setup", json!({ "mode": "password", "password": PASSWORD }))).unwrap();
    (service, dir)
}

fn call(service: &CoreService, op: &str) -> Result<Value, AppError> {
    block_on(service.invoke(op, json!({})))
}

fn thread_name() -> String {
    std::thread::current().name().unwrap_or_default().to_owned()
}

fn wait_for(flag: &AtomicBool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !flag.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_service_operation_runs_on_a_job_thread_and_the_core_on_the_worker() {
    fn whoami(ctx: &JobCtx, _: Value) -> Result<Value, AppError> {
        let on_worker = ctx.with_core(|_| thread_name())?;
        Ok(json!({ "job": thread_name(), "worker": on_worker }))
    }
    let (service, _dir) = service(|t| {
        t.add("test.whoami", whoami);
    });
    let answer = call(&service, "test.whoami").unwrap();
    assert_eq!(answer["job"], "kb-job test.whoami");
    assert_eq!(answer["worker"], "kb-service");
}

#[test]
fn with_core_reaches_the_database() {
    fn count(ctx: &JobCtx, _: Value) -> Result<Value, AppError> {
        ctx.with_core(|w| w.core().dispatch("accounts.list", json!({}), kb_core::Actor::User))?
    }
    let (service, _dir) = service(|t| {
        t.add("test.count", count);
    });
    assert_eq!(call(&service, "test.count").unwrap(), json!([]));
}

#[test]
fn a_slow_service_operation_does_not_block_a_core_operation() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    static RELEASE: AtomicBool = AtomicBool::new(false);
    fn slow(_: &JobCtx, _: Value) -> Result<Value, AppError> {
        STARTED.store(true, Ordering::SeqCst);
        wait_for(&RELEASE);
        Ok(json!("done"))
    }
    let (service, _dir) = service(|t| {
        t.add("test.slow", slow);
    });
    let service = Arc::new(service);
    let running = {
        let service = service.clone();
        std::thread::spawn(move || call(&service, "test.slow"))
    };
    wait_for(&STARTED);
    let start = Instant::now();
    assert_eq!(call(&service, "accounts.list").unwrap(), json!([]));
    assert_eq!(call(&service, "auth.status").unwrap()["state"], "unlocked");
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(!running.is_finished(), "the slow operation is still running");
    RELEASE.store(true, Ordering::SeqCst);
    assert_eq!(running.join().unwrap().unwrap(), json!("done"));
}

#[test]
fn locking_cancels_the_running_jobs() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    fn until_cancelled(ctx: &JobCtx, _: Value) -> Result<Value, AppError> {
        STARTED.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            ctx.cancel().check()?;
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(json!("never cancelled"))
    }
    let (service, _dir) = service(|t| {
        t.add("test.untilCancelled", until_cancelled);
    });
    let service = Arc::new(service);
    let running = {
        let service = service.clone();
        std::thread::spawn(move || call(&service, "test.untilCancelled"))
    };
    wait_for(&STARTED);
    call(&service, "auth.lock").unwrap();
    assert_eq!(running.join().unwrap().unwrap_err().code, "job.cancelled");
}

#[test]
fn a_cancelled_job_cannot_use_the_core_any_more() {
    static CANCELLED: AtomicBool = AtomicBool::new(false);
    fn after_lock(ctx: &JobCtx, _: Value) -> Result<Value, AppError> {
        while !ctx.cancel().is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        CANCELLED.store(true, Ordering::SeqCst);
        ctx.with_core(|_| ())?;
        Ok(json!("reached the core"))
    }
    let (service, _dir) = service(|t| {
        t.add("test.afterLock", after_lock);
    });
    let service = Arc::new(service);
    let running = {
        let service = service.clone();
        std::thread::spawn(move || call(&service, "test.afterLock"))
    };
    std::thread::sleep(Duration::from_millis(50));
    call(&service, "auth.lock").unwrap();
    wait_for(&CANCELLED);
    assert_eq!(running.join().unwrap().unwrap_err().code, "job.cancelled");
}

#[test]
fn a_service_operation_is_refused_while_locked_and_runs_again_after_the_unlock() {
    fn ping(_: &JobCtx, _: Value) -> Result<Value, AppError> {
        Ok(json!("pong"))
    }
    let (service, _dir) = service(|t| {
        t.add("test.ping", ping);
    });
    call(&service, "auth.lock").unwrap();
    assert_eq!(call(&service, "test.ping").unwrap_err().code, "auth.locked");
    block_on(service.invoke("auth.unlock", json!({ "password": PASSWORD }))).unwrap();
    assert_eq!(call(&service, "test.ping").unwrap(), json!("pong"));
}

#[test]
fn the_standard_table_has_no_duplicate_and_the_names_are_listed() {
    let names: Vec<&str> = kb_service::service_table().names().collect();
    assert!(kb_service::SERVICE_OPS.iter().all(|n| n.starts_with("app.") || names.contains(n)));
    assert!(kb_service::SERVICE_OPS.contains(&"app.info"));
}

#[test]
#[should_panic(expected = "registered twice")]
fn a_name_registered_twice_is_a_programming_error() {
    fn ping(_: &JobCtx, _: Value) -> Result<Value, AppError> {
        Ok(Value::Null)
    }
    let mut table = ServiceTable::new();
    table.add("test.ping", ping).add("test.ping", ping);
}

#[test]
fn the_fake_desktop_answers_from_its_queue_and_remembers_the_calls() {
    let desktop = FakeDesktop::new(vec![Some(PathBuf::from("/tmp/out.csv")), None, Some(PathBuf::from("/tmp/in.kasboek"))]);
    assert_eq!(desktop.save_file("Export", "a.csv", &[("CSV", &["csv"])]), Some(PathBuf::from("/tmp/out.csv")));
    assert_eq!(desktop.open_file("Open", &[]), None);
    assert_eq!(desktop.pick_folder("Folder"), Some(PathBuf::from("/tmp/in.kasboek")));
    assert_eq!(desktop.pick_folder("Folder"), None, "an empty queue cancels");
    assert!(desktop.open_path(Path::new("/tmp")) && desktop.open_url("https://example.org"));
    assert_eq!(
        desktop.calls(),
        vec![
            DesktopCall::SaveFile { title: "Export".into(), default_name: "a.csv".into() },
            DesktopCall::OpenFile { title: "Open".into() },
            DesktopCall::PickFolder { title: "Folder".into() },
            DesktopCall::PickFolder { title: "Folder".into() },
            DesktopCall::OpenPath(PathBuf::from("/tmp")),
            DesktopCall::OpenUrl("https://example.org".into()),
        ]
    );
    assert!(NoDesktop.save_file("t", "n", &[]).is_none() && !NoDesktop.open_url("https://example.org"));
}

#[test]
fn the_fake_http_replays_in_order_and_pins_the_urls() {
    let http = FakeHttp::new(vec![
        Recorded::new("https://a.example/x", 200, "hello"),
        Recorded::from_json(&json!({ "url": "https://a.example/stream", "sse": ["{\"a\":1}", "[DONE]"] })).unwrap(),
        Recorded::new("https://a.example/big", 404, "0123456789"),
    ]);
    let answer = http.send(HttpRequest::post("https://a.example/x", b"{}".to_vec())).unwrap();
    assert_eq!((answer.status, answer.body.as_slice()), (200, &b"hello"[..]));
    let mut lines = Vec::new();
    let status = http.stream(HttpRequest::get("https://a.example/stream"), &Cancel::new(), &mut |l| lines.push(l.to_owned())).unwrap();
    assert_eq!((status, lines), (200, vec!["data: {\"a\":1}".to_owned(), String::new(), "data: [DONE]".to_owned(), String::new()]));
    let mut small = HttpRequest::get("https://a.example/big");
    small.max_body = 4;
    assert_eq!(http.send(small), Err(HttpError::TooLarge));
    assert!(matches!(http.send(HttpRequest::get("https://a.example/more")), Err(HttpError::Unexpected(_))), "none left");
    let seen = http.requests();
    assert_eq!((seen.len(), seen[0].method.as_str(), seen[0].body.as_deref()), (4, "POST", Some(&b"{}"[..])));
}

#[test]
fn a_stream_stops_when_cancelled() {
    let http = FakeHttp::new(vec![Recorded::new("https://a.example/s", 200, "one\ntwo\nthree\n")]);
    let cancel = Cancel::new();
    let mut seen = Vec::new();
    let result = http.stream(HttpRequest::get("https://a.example/s"), &cancel, &mut |l| {
        seen.push(l.to_owned());
        cancel.cancel();
    });
    assert_eq!((result, seen), (Err(HttpError::Cancelled), vec!["one".to_owned()]));
}
