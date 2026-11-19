use kb_service::{block_on, AppEvent, AppService, CoreService, FixtureConfig, FixtureService, DEMO_PASSWORD};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn fast() -> FixtureConfig {
    FixtureConfig { unlock_delay: Duration::ZERO, ..FixtureConfig::default() }
}

#[test]
fn fixture_locks_and_unlocks() {
    let s = FixtureService::bundled(fast());
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    s.subscribe(Arc::new(move |e| sink.lock().unwrap().push(e)));
    assert_eq!(block_on(s.invoke("auth.status", json!({}))).unwrap()["state"], "locked");
    assert_eq!(block_on(s.invoke("summary.month", json!({ "month": "2026-11" }))).unwrap_err().code, "auth.locked");
    let wrong = block_on(s.invoke("auth.unlock", json!({ "password": "nope" }))).unwrap_err();
    assert_eq!(wrong.code, "auth.wrong_password");
    let ok = block_on(s.invoke("auth.unlock", json!({ "password": DEMO_PASSWORD }))).unwrap();
    assert_eq!(ok["state"], "unlocked");
    let summary = block_on(s.invoke("summary.month", json!({ "month": "2026-11" }))).unwrap();
    assert_eq!(summary["incomeCents"], 269000);
    assert_eq!(block_on(s.invoke("goals.nope", json!({}))).unwrap_err().code, "op.not_ported");
    let progress = events.lock().unwrap().iter().filter(|e| matches!(e, AppEvent::LoadProgress { .. })).count();
    assert!(progress >= 4);
}

#[test]
fn fixture_throttles_after_three_failures() {
    let s = FixtureService::bundled(fast());
    for _ in 0..3 {
        let _ = block_on(s.invoke("auth.unlock", json!({ "password": "nope" })));
    }
    assert!(block_on(s.invoke("auth.status", json!({}))).unwrap()["throttleSeconds"].as_u64().unwrap() > 0);
}

#[test]
fn core_service_runs_ported_ops_and_refuses_the_rest() {
    let s = CoreService::temporary(false).unwrap();
    assert_eq!(block_on(s.invoke("accounts.list", json!({}))).unwrap_err().code, "auth.locked");
    block_on(s.invoke("auth.unlock", json!({ "password": DEMO_PASSWORD }))).unwrap();
    let accounts = block_on(s.invoke("accounts.list", json!({}))).unwrap();
    assert_eq!(accounts.as_array().unwrap().len(), 2);
    assert_eq!(block_on(s.invoke("assistant.status", json!({}))).unwrap_err().code, "op.not_ported");
    assert!(block_on(s.invoke("categories.list", json!({}))).unwrap().as_array().unwrap().len() >= 4);
}
