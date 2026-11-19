//! The `auth.*` operations as plain handlers that `kb-core` can register later.
//!
//! `kb-core` owns `dispatch`; it must not depend on this crate's internals, so the contract is small:
//!
//! ```ignore
//! for op in kb_session::ops::register_ops::<SqliteStore>() {
//!     // op.name, op.in_contract, op.mutates (the flags of table.rs; assistant is always false)
//!     table.insert(op.name, move |session: &mut Session<SqliteStore>, input: Value| (op.handler)(session, input));
//! }
//! ```
//!
//! A handler gets the session and the JSON input of the call and returns the JSON output or a [`SessionError`]
//! (`code`, `message`, as `AppError`). `kb-core` maps the error with `AppError::new(&e.code, e.message)`. Inputs are
//! validated like the zod schemas of src/shared/contract.ts (strict keys, lengths); a failure is `op.invalid_input`.
//! The caller's own steps stay with the caller: after `auth.setup` it localizes the default categories; after
//! `auth.unlock` and `auth.unlockRecovery` it runs its after-unlock work (sync scheduler, backups).
//!
//! Names: those with `in_contract: true` are in the contract (`auth.usePasswordless`, `auth.unlockRecovery`, ...).
//! `auth.exists`, `auth.reauth`, `auth.recover` and `auth.switchToPasswordless` are extra aliases for the app's own
//! Rust UI; leave them out of the table that is compared with contract.json. The TypeScript has no `auth.device*`
//! operations: the device check runs inside `auth.unlock`, `auth.setup`, `auth.usePasswordless` and `auth.erase`.
use crate::account::AuthMode;
use crate::error::{SessionError, SessionResult};
use crate::password::check_password;
use crate::session::{LockReason, Session, UnlockInput};
use kb_db::Store;
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

pub type OpHandler<S> = fn(&mut Session<S>, Value) -> SessionResult<Value>;

pub struct OpSpec<S: Store> {
    pub name: &'static str,
    pub in_contract: bool,
    pub mutates: bool,
    pub handler: OpHandler<S>,
}

const WEAK: &str = "This password doesn’t meet the requirements: at least 12 characters, three kinds of characters, and not a common or predictable password.";

fn object<'a>(input: &'a Value, allowed: &[&str]) -> SessionResult<&'a Map<String, Value>> {
    let map = input.as_object().ok_or_else(|| SessionError::invalid_input("Expected an object."))?;
    if let Some(k) = map.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(SessionError::invalid_input(format!("Unrecognized key: {k}")));
    }
    Ok(map)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn string<'a>(map: &'a Map<String, Value>, key: &str, max: usize) -> SessionResult<Option<&'a str>> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if utf16_len(s) <= max => Ok(Some(s)),
        _ => Err(SessionError::invalid_input(format!("Invalid {key}."))),
    }
}

fn required<'a>(map: &'a Map<String, Value>, key: &str, max: usize) -> SessionResult<&'a str> {
    string(map, key, max)?.ok_or_else(|| SessionError::invalid_input(format!("{key} is required.")))
}

fn password<'a>(map: &'a Map<String, Value>, key: &str) -> SessionResult<&'a str> {
    let p = required(map, key, 256)?;
    if !check_password(p).ok {
        return Err(SessionError::invalid_input(WEAK));
    }
    Ok(p)
}

fn status<S: Store>(s: &mut Session<S>) -> SessionResult<Value> {
    serde_json::to_value(s.status()).map_err(|_| SessionError::failed())
}

fn op_status<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    object(&input, &[])?;
    status(s)
}

fn op_exists<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    object(&input, &[])?;
    Ok(json!(s.account_exists()))
}

fn op_setup<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["mode", "password"])?;
    let key = match map.get("mode").and_then(Value::as_str) {
        Some("password") => {
            let p = password(map, "password")?;
            s.setup(AuthMode::Password, Some(p))?
        }
        Some("device") => {
            if map.contains_key("password") {
                return Err(SessionError::invalid_input("Unrecognized key: password"));
            }
            s.setup(AuthMode::Device, None)?
        }
        _ => return Err(SessionError::invalid_input("Invalid mode.")),
    };
    Ok(json!({ "recoveryKey": key.as_str() }))
}

fn op_unlock<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["password", "code", "remember"])?;
    let remember = match map.get("remember") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return Err(SessionError::invalid_input("Invalid remember.")),
    };
    let unlock = UnlockInput {
        password: string(map, "password", 256)?.map(|p| Zeroizing::new(p.to_owned())),
        code: string(map, "code", 12)?.map(|c| Zeroizing::new(c.to_owned())),
        remember,
    };
    s.unlock(&unlock)?;
    status(s)
}

fn op_unlock_recovery<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["recoveryKey"])?;
    let key = required(map, "recoveryKey", 80)?;
    if utf16_len(key) < 10 {
        return Err(SessionError::invalid_input("Invalid recoveryKey."));
    }
    s.unlock_recovery(key)?;
    status(s)
}

fn op_lock<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    object(&input, &[])?;
    s.lock(LockReason::User, false);
    status(s)
}

fn op_erase<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["confirm"])?;
    if map.get("confirm").and_then(Value::as_str) != Some("ERASE") {
        return Err(SessionError::invalid_input("Invalid confirm."));
    }
    s.erase()?;
    status(s)
}

fn op_restore_erased<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["name"])?;
    let name = required(map, "name", usize::MAX)?;
    if !crate::quarantine::is_entry_name(name) {
        return Err(SessionError::invalid_input("Invalid name."));
    }
    s.restore_erased_data(name)?;
    status(s)
}

fn op_change_password<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["current", "next"])?;
    let current = string(map, "current", 256)?;
    let next = password(map, "next")?;
    s.change_password(current, next)?;
    status(s)
}

fn op_use_passwordless<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["current"])?;
    s.switch_to_passwordless(string(map, "current", 256)?)?;
    status(s)
}

fn op_reauth<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["current"])?;
    s.reauth(string(map, "current", 256)?)?;
    status(s)
}

fn op_new_recovery_key<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["current"])?;
    let key = s.new_recovery_key(string(map, "current", 256)?)?;
    Ok(json!({ "recoveryKey": key.as_str() }))
}

fn op_forget_computer<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    object(&input, &[])?;
    s.forget_this_computer()?;
    status(s)
}

fn op_totp_begin<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    object(&input, &[])?;
    let (secret, uri, qr) = s.totp_begin()?;
    Ok(json!({ "secret": secret.as_str(), "uri": uri.as_str(), "qrSvg": qr }))
}

fn op_totp_enable<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["code"])?;
    let code = required(map, "code", usize::MAX)?.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(SessionError::invalid_input("Enter the 6-digit code."));
    }
    s.totp_enable(code)?;
    status(s)
}

fn op_totp_disable<S: Store>(s: &mut Session<S>, input: Value) -> SessionResult<Value> {
    let map = object(&input, &["code"])?;
    s.totp_disable(required(map, "code", 12)?)?;
    status(s)
}

/// All handlers, in the order of the contract.
pub fn register_ops<S: Store>() -> Vec<OpSpec<S>> {
    let op = |name, in_contract, mutates, handler: OpHandler<S>| OpSpec { name, in_contract, mutates, handler };
    vec![
        op("auth.status", true, false, op_status::<S>),
        op("auth.setup", true, true, op_setup::<S>),
        op("auth.unlock", true, false, op_unlock::<S>),
        op("auth.forgetComputer", true, true, op_forget_computer::<S>),
        op("auth.unlockRecovery", true, false, op_unlock_recovery::<S>),
        op("auth.lock", true, false, op_lock::<S>),
        op("auth.erase", true, false, op_erase::<S>),
        op("auth.restoreErased", true, false, op_restore_erased::<S>),
        op("auth.changePassword", true, true, op_change_password::<S>),
        op("auth.usePasswordless", true, true, op_use_passwordless::<S>),
        op("auth.newRecoveryKey", true, true, op_new_recovery_key::<S>),
        op("auth.totpBegin", true, false, op_totp_begin::<S>),
        op("auth.totpEnable", true, true, op_totp_enable::<S>),
        op("auth.totpDisable", true, true, op_totp_disable::<S>),
        op("auth.exists", false, false, op_exists::<S>),
        op("auth.reauth", false, false, op_reauth::<S>),
        op("auth.recover", false, false, op_unlock_recovery::<S>),
        op("auth.switchToPasswordless", false, true, op_use_passwordless::<S>),
    ]
}
