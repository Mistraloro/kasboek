//! Dev-only driver for the differential checks (rust/parity/session.spec.ts): runs a script of session steps read
//! from stdin and prints one result per step as JSON. Never shipped. All secrets in scripts are invented.
//!
//! Script: `{"dir", "now", "kdf":{"m","t","p"}, "sealKey":"<64 hex>", "seed", "device":{"kind","verify"}, "steps":[...]}`.
//! Steps: `{"op","input"}`, `{"now":ms}`, `{"advance":ms}`, `{"device":{"kind","verify"}}`, `{"reload":true}`.
//! An optional `"lastAuth":{"mode","twoFactor","rememberedUntil","attempts":{"failed","lastFailedAt"}}` (script, and on a
//! reload step to replace it) is the non-secret hint the session starts with: a device account then stays sealed until
//! the device check (the TypeScript has no such hint and opens the account at start; the results must not differ).
//! In inputs, `"$recovery"` is the last recovery key returned, `"$recoveryLoose"` the same in lower case with spaces,
//! and `"$totp"` / `"$totp:<seconds>"` the 6-digit code of the last 2FA secret at the clock (plus an offset).
//! `vars` ({"recovery", "totpSecret"}) carries values from an earlier run in the same folder.
//! A script `{"checkPassword":[...]}` prints the password rule results instead.
use kb_crypto::slot::Argon2Cost;
use kb_crypto::totp::totp_at;
use kb_db::SqliteStore;
use kb_session::account::{Attempts, AuthMode};
use kb_session::device::{DeviceKind, FakeDevice};
use kb_session::ops::{register_ops, OpSpec};
use kb_session::password::check_password;
use kb_session::seal::FileSeal;
use kb_session::session::Hint;
use kb_session::time::{ManualClock, SeededRng};
use kb_session::{Config, Paths, Session};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::Arc;

fn device_kind(v: &Value) -> Option<DeviceKind> {
    match v.as_str() {
        Some("touch-id") => Some(DeviceKind::TouchId),
        Some("windows-hello") => Some(DeviceKind::WindowsHello),
        _ => None,
    }
}

fn hint(v: &Value) -> Option<Hint> {
    let mode = match v.get("mode")?.as_str()? {
        "device" => AuthMode::Device,
        _ => AuthMode::Password,
    };
    Some(Hint {
        mode,
        two_factor: v["twoFactor"].as_bool().unwrap_or(false),
        remembered_until: v["rememberedUntil"].as_str().map(str::to_owned),
        attempts: Attempts {
            failed: v["attempts"]["failed"].as_u64().unwrap_or(0),
            last_failed_at: v["attempts"]["lastFailedAt"].as_str().map(str::to_owned),
        },
    })
}

struct Vars {
    recovery: String,
    totp_secret: String,
    now_ms: i64,
}

fn resolve(v: &Value, vars: &Vars) -> Value {
    match v {
        Value::String(s) if s == "$recovery" => json!(vars.recovery),
        Value::String(s) if s == "$recoveryLoose" => json!(vars.recovery.to_lowercase().replace('-', " ")),
        Value::String(s) if s == "$totp" || s.starts_with("$totp:") => {
            let offset: i64 = s.strip_prefix("$totp:").and_then(|o| o.parse().ok()).unwrap_or(0);
            json!(totp_at(&vars.totp_secret, vars.now_ms / 1000 + offset, 6).unwrap_or_default())
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, vars)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, vars))).collect()),
        other => other.clone(),
    }
}

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("stdin");
    let script: Value = serde_json::from_str(&text).expect("a JSON script");
    if let Some(list) = script.get("checkPassword").and_then(Value::as_array) {
        let out: Vec<Value> = list
            .iter()
            .map(|p| {
                let c = check_password(p.as_str().unwrap_or(""));
                json!({ "ok": c.ok, "issues": c.issues.iter().map(|i| i.as_str()).collect::<Vec<_>>(), "strength": c.strength, "bits": c.bits, "classes": c.classes })
            })
            .collect();
        println!("{}", Value::Array(out));
        return;
    }
    let dir = std::path::PathBuf::from(script["dir"].as_str().expect("dir"));
    let clock = Arc::new(ManualClock::new(script["now"].as_i64().unwrap_or(0)));
    let device = Arc::new(FakeDevice::new(device_kind(&script["device"]["kind"]), script["device"]["verify"].as_bool().unwrap_or(true)));
    // A null sealKey is a computer without an OS seal (account.json is written with seal "none").
    let seal: Box<dyn kb_session::seal::OsSeal> = match script["sealKey"].as_str() {
        Some(k) => Box::new(FileSeal::new(hex::decode(k).expect("hex").try_into().expect("32 bytes"))),
        None => Box::new(kb_session::seal::Unsupported),
    };
    let mut config = Config::new(
        Paths::in_dir(&dir),
        Box::new(clock.clone()),
        Box::new(SeededRng::new(script["seed"].as_u64().unwrap_or(1))),
        seal,
        Box::new(device.clone()),
    );
    if let Some(k) = script.get("kdf").filter(|k| k.is_object()) {
        config.cost = Argon2Cost { m: k["m"].as_u64().unwrap_or(64), t: k["t"].as_u64().unwrap_or(1), p: k["p"].as_u64().unwrap_or(1) };
    }
    let mut session: Session<SqliteStore> = Session::new(config);
    let mut last_auth = hint(&script["lastAuth"]);
    session.init(last_auth.clone());
    let ops = register_ops::<SqliteStore>();
    let mut vars = Vars {
        recovery: script["vars"]["recovery"].as_str().unwrap_or("").to_owned(),
        totp_secret: script["vars"]["totpSecret"].as_str().unwrap_or("").to_owned(),
        now_ms: clock.now_ms_value(),
    };
    let mut results = Vec::new();
    for step in script["steps"].as_array().expect("steps") {
        if let Some(ms) = step.get("now").and_then(Value::as_i64) {
            clock.set(ms);
        } else if let Some(ms) = step.get("advance").and_then(Value::as_i64) {
            clock.advance(ms);
        } else if let Some(d) = step.get("device") {
            device.set(device_kind(&d["kind"]), d["verify"].as_bool().unwrap_or(true));
        } else if step.get("reload").is_some() {
            if let Some(h) = step.get("lastAuth") {
                last_auth = hint(h);
            }
            session.init(last_auth.clone());
        } else if let Some(name) = step.get("op").and_then(Value::as_str) {
            vars.now_ms = clock.now_ms_value();
            let input = resolve(&step["input"], &vars);
            let spec: &OpSpec<SqliteStore> = ops.iter().find(|o| o.name == name).expect("a known op");
            let result = match (spec.handler)(&mut session, input) {
                Ok(data) => {
                    if let Some(k) = data.get("recoveryKey").and_then(Value::as_str) {
                        vars.recovery = k.to_owned();
                    }
                    if name == "auth.totpBegin" {
                        vars.totp_secret = data["secret"].as_str().unwrap_or("").replace(' ', "");
                    }
                    json!({ "ok": true, "data": data })
                }
                Err(e) => json!({ "ok": false, "error": e.to_json() }),
            };
            results.push(json!({ "result": result, "unlocked": session.is_unlocked() }));
        }
    }
    println!("{}", Value::Array(results));
}
