//! The real service on a temporary data folder: account, lock, throttle, change of password, recovery, 2FA, auto-lock.
use kb_crypto::slot::Argon2Cost;
use kb_crypto::totp::totp_at;
use kb_service::{block_on, AppError, AppEvent, AppService, CoreOptions, CoreService, LoadStep, OsEvents};
use kb_session::seal::FileSeal;
use kb_session::time::ManualClock;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const START: i64 = 1_794_650_400_000;
const PASSWORD: &str = "Tulip-Harbour-Lantern-48";
const NEXT_PASSWORD: &str = "Maple-Quartz-Meadow-91";

struct Fake {
    idle: AtomicU64,
    lock: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

struct Shared(Arc<Fake>);

impl OsEvents for Shared {
    fn idle_seconds(&self) -> Option<u64> {
        Some(self.0.idle.load(Ordering::Relaxed))
    }

    fn on_system_lock(&self, on_lock: Box<dyn Fn() + Send + Sync>) {
        *self.0.lock.lock().unwrap() = Some(on_lock);
    }
}

struct Rig {
    service: CoreService,
    clock: Arc<ManualClock>,
    os: Arc<Fake>,
    events: Arc<Mutex<Vec<AppEvent>>>,
    dir: tempfile::TempDir,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(START));
    let os = Arc::new(Fake { idle: AtomicU64::new(0), lock: Mutex::new(None) });
    let mut options = CoreOptions::new(dir.path().to_path_buf());
    options.seal = Box::new(FileSeal::new([3; 32]));
    options.clock = Some(clock.clone());
    options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
    options.os_events = Arc::new(Shared(os.clone()));
    options.tick = Duration::from_millis(40);
    let service = CoreService::open(options).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    service.subscribe(Arc::new(move |e| sink.lock().unwrap().push(e)));
    Rig { service, clock, os, events, dir }
}

impl Rig {
    fn call(&self, op: &str, input: Value) -> Result<Value, AppError> {
        block_on(self.service.invoke(op, input))
    }

    fn state(&self) -> String {
        self.call("auth.status", json!({})).unwrap()["state"].as_str().unwrap().to_owned()
    }

    fn wait_for_state(&self, want: &str) {
        let until = Instant::now() + Duration::from_secs(5);
        while self.state() != want {
            assert!(Instant::now() < until, "never became {want}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn setup_lock_throttle_unlock_change_password_recovery_and_two_factor() {
    let r = rig();
    // Before the account exists: setup, and nothing else.
    assert_eq!(r.state(), "setup");
    assert_eq!(r.call("accounts.list", json!({})).unwrap_err().code, "auth.locked");
    assert_eq!(r.call("auth.setup", json!({ "mode": "password", "password": "short" })).unwrap_err().code, "op.invalid_input");
    let recovery =
        r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap()["recoveryKey"].as_str().unwrap().to_owned();
    assert_eq!(r.state(), "unlocked");
    assert!(r
        .call("accounts.create", json!({ "name": "Everyday", "kind": "current", "currency": "EUR", "openingBalanceCents": 12_500 }))
        .is_ok());
    assert_eq!(r.call("accounts.list", json!({})).unwrap().as_array().unwrap().len(), 1);
    assert!(r.events.lock().unwrap().iter().any(|e| matches!(e, AppEvent::DataChanged { .. })));

    // Nothing of the password or the recovery key is written to the data folder.
    for name in ["account.json", "prefs.json"] {
        let text = std::fs::read_to_string(r.dir.path().join(name)).unwrap();
        assert!(!text.contains(PASSWORD) && !text.contains(&recovery), "{name}");
    }
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(r.dir.path().join("prefs.json")).unwrap()).unwrap()["lastAuth"]["mode"],
        "password"
    );

    // Lock: the database is closed, the operations are refused, the app is told.
    r.call("auth.lock", json!({})).unwrap();
    assert!(r.events.lock().unwrap().iter().any(|e| matches!(e, AppEvent::Locked { reason } if reason == "user")));
    assert_eq!(r.call("accounts.list", json!({})).unwrap_err().code, "auth.locked");
    assert_eq!(r.call("auth.lock", json!({})).unwrap_err().code, "auth.locked");
    // The preferences and app facts work while locked.
    assert_eq!(r.call("prefs.get", json!({})).unwrap()["autoLockMinutes"], 10);
    assert_eq!(r.call("app.info", json!({})).unwrap()["name"], "Kasboek");

    // Five free wrong tries, then the throttle with its seconds in the error details.
    for _ in 0..5 {
        assert_eq!(r.call("auth.unlock", json!({ "password": "Wrong-Password-12345" })).unwrap_err().code, "auth.failed");
    }
    let throttled = r.call("auth.unlock", json!({ "password": PASSWORD })).unwrap_err();
    assert_eq!(throttled.code, "auth.throttled");
    assert!(throttled.details.as_ref().unwrap()["throttleSeconds"].as_u64().unwrap() >= 29);
    assert!(r.call("auth.status", json!({})).unwrap()["throttleSeconds"].as_u64().unwrap() > 0);
    r.clock.advance(10 * 60_000);
    let before = r.events.lock().unwrap().len();
    let unlocked = r.call("auth.unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(unlocked["state"], "unlocked");
    assert_eq!(unlocked["throttleSeconds"], 0);
    let steps: Vec<LoadStep> = r.events.lock().unwrap()[before..]
        .iter()
        .filter_map(|e| match e {
            AppEvent::LoadProgress { step, .. } => Some(*step),
            _ => None,
        })
        .collect();
    assert_eq!(steps.first(), Some(&LoadStep::Opening));
    assert!(steps.contains(&LoadStep::Migrating));
    // The data is still there after the lock.
    assert_eq!(r.call("accounts.list", json!({})).unwrap()[0]["name"], "Everyday");

    // Change of password: the old one stops working.
    assert_eq!(
        r.call("auth.changePassword", json!({ "current": "Not-The-Password-77", "next": NEXT_PASSWORD })).unwrap_err().code,
        "auth.failed"
    );
    r.call("auth.changePassword", json!({ "current": PASSWORD, "next": NEXT_PASSWORD })).unwrap();
    r.call("auth.lock", json!({})).unwrap();
    assert!(r.call("auth.unlock", json!({ "password": PASSWORD })).is_err());
    r.clock.advance(10 * 60_000);
    r.call("auth.unlock", json!({ "password": NEXT_PASSWORD })).unwrap();

    // The recovery key opens the account (and keeps working after the change of password).
    r.call("auth.lock", json!({})).unwrap();
    let status = r.call("auth.unlockRecovery", json!({ "recoveryKey": recovery })).unwrap();
    assert_eq!((status["state"].as_str(), status["recovered"].as_bool()), (Some("unlocked"), Some(true)));

    // 2FA: begin gives the secret and a QR code, a wrong code is refused, a right one turns it on.
    let begin = r.call("auth.totpBegin", json!({})).unwrap();
    let secret = begin["secret"].as_str().unwrap().to_owned();
    assert!(begin["uri"].as_str().unwrap().starts_with("otpauth://totp/"));
    assert!(begin["qrSvg"].as_str().unwrap().contains("<svg"));
    assert!(r.call("auth.totpEnable", json!({ "code": "000000" })).is_err());
    let code = |r: &Rig| totp_at(&secret, r.clock.now_ms_value() / 1000, 6).unwrap();
    r.call("auth.totpEnable", json!({ "code": code(&r) })).unwrap();
    r.call("auth.lock", json!({})).unwrap();
    assert_eq!(r.call("auth.status", json!({})).unwrap()["twoFactor"], true);
    assert!(r.call("auth.unlock", json!({ "password": NEXT_PASSWORD })).is_err());
    // A used code is not accepted twice, so the next step of 30 seconds gives a new one.
    r.clock.advance(10 * 60_000);
    let status = r.call("auth.unlock", json!({ "password": NEXT_PASSWORD, "code": code(&r), "remember": true })).unwrap();
    assert_eq!(status["state"], "unlocked");
    assert!(status["rememberedUntil"].is_string());
}

#[test]
fn the_idle_timer_and_the_system_lock_lock_the_session() {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    r.call("prefs.update", json!({ "autoLockMinutes": 1 })).unwrap();
    r.os.idle.store(30, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(r.state(), "unlocked");
    r.os.idle.store(61, Ordering::Relaxed);
    r.wait_for_state("locked");
    assert!(r.events.lock().unwrap().iter().any(|e| matches!(e, AppEvent::Locked { reason } if reason == "idle")));
    assert_eq!(r.call("accounts.list", json!({})).unwrap_err().code, "auth.locked");

    r.os.idle.store(0, Ordering::Relaxed);
    r.call("auth.unlock", json!({ "password": PASSWORD })).unwrap();
    (r.os.lock.lock().unwrap().as_ref().expect("the service registered for system lock events"))();
    r.wait_for_state("locked");
    assert!(r.events.lock().unwrap().iter().any(|e| matches!(e, AppEvent::Locked { reason } if reason == "system")));
}

#[test]
fn erase_needs_the_typed_word_and_starts_fresh() {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    r.call("auth.lock", json!({})).unwrap();
    assert_eq!(r.call("auth.erase", json!({ "confirm": "no" })).unwrap_err().code, "op.invalid_input");
    let status = r.call("auth.erase", json!({ "confirm": "ERASE" })).unwrap();
    assert_eq!(status["state"], "setup");
    assert_eq!(status["erased"].as_array().unwrap().len(), 1);
    assert!(serde_json::from_str::<Value>(&std::fs::read_to_string(r.dir.path().join("prefs.json")).unwrap())
        .unwrap()
        .get("lastAuth")
        .is_none());
}

#[test]
fn a_second_start_reads_the_account_and_the_cached_lock_facts() {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    r.call("accounts.create", json!({ "name": "Everyday", "kind": "current", "currency": "EUR" })).unwrap();
    let dir = r.dir.path().to_path_buf();
    drop(r.service);
    let mut options = CoreOptions::new(dir);
    options.seal = Box::new(FileSeal::new([3; 32]));
    options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
    let again = CoreService::open(options).unwrap();
    let status = block_on(again.invoke("auth.status", json!({}))).unwrap();
    assert_eq!((status["state"].as_str(), status["mode"].as_str()), (Some("locked"), Some("password")));
    block_on(again.invoke("auth.unlock", json!({ "password": PASSWORD }))).unwrap();
    assert_eq!(block_on(again.invoke("accounts.list", json!({}))).unwrap()[0]["name"], "Everyday");
}

/// The id of the import session a fresh start opens for a small CSV (random, from the core's generator).
fn import_session_id_of_a_fresh_start() -> String {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    let id =
        r.call("accounts.create", json!({ "name": "Everyday", "kind": "current", "currency": "EUR" })).unwrap()["id"].as_i64().unwrap();
    let file = "RGF0ZSxBbW91bnQsRGVzY3JpcHRpb24KMjAyNi0xMS0wMSwtNS4wMCxDb2ZmZWUKMjAyNi0xMS0wMiwtNy41MCxCcmVhZAo=";
    let preview = r.call("import.analyze", json!({ "fileName": "a.csv", "contentBase64": file, "accountId": id })).unwrap();
    let session = preview["sessionId"].as_str().expect("the preview names its session").to_owned();
    assert_eq!(session.len(), 36);
    session
}

#[test]
fn two_starts_make_different_import_session_ids() {
    assert_ne!(import_session_id_of_a_fresh_start(), import_session_id_of_a_fresh_start());
}

#[test]
fn wrong_tries_are_kept_in_last_auth_and_forgotten_after_a_correct_one() {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    r.call("auth.lock", json!({})).unwrap();
    for _ in 0..3 {
        assert_eq!(r.call("auth.unlock", json!({ "password": "Wrong-Password-12345" })).unwrap_err().code, "auth.failed");
    }
    let last = |r: &Rig| {
        serde_json::from_str::<Value>(&std::fs::read_to_string(r.dir.path().join("prefs.json")).unwrap()).unwrap()["lastAuth"].clone()
    };
    assert_eq!(last(&r)["attempts"]["failed"], 3);
    assert!(last(&r)["attempts"]["lastFailedAt"].is_string());
    r.call("auth.unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(last(&r)["attempts"]["failed"], 0);
}

#[test]
fn erase_while_unlocked_closes_the_cores_handle_first() {
    let r = rig();
    r.call("auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    r.call("accounts.create", json!({ "name": "Everyday", "kind": "current", "currency": "EUR" })).unwrap();
    let status = r.call("auth.erase", json!({ "confirm": "ERASE" })).unwrap();
    assert_eq!(status["state"], "setup");
    assert_eq!(r.call("accounts.list", json!({})).unwrap_err().code, "auth.locked");
    let name = status["erased"][0]["name"].as_str().unwrap().to_owned();
    assert_eq!(r.call("auth.restoreErased", json!({ "name": name })).unwrap()["state"], "locked");
    r.call("auth.unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(r.call("accounts.list", json!({})).unwrap()[0]["name"], "Everyday");
}
