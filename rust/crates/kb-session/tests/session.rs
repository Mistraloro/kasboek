//! Session behaviour end to end, with a cheap KDF, a manual clock, a seeded Rng, the test seal and a fake device.
//! All data is invented.
use kb_crypto::slot::Argon2Cost;
use kb_db::SqliteStore;
use kb_session::account::AuthMode;
use kb_session::device::{DeviceKind, FakeDevice};
use kb_session::ops::register_ops;
use kb_session::seal::{FileSeal, OsSeal, Unsupported};
use kb_session::session::{Event, Hint, LockReason, UnlockInput};
use kb_session::time::{ManualClock, SeededRng};
use kb_session::{Config, Paths, Session};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

const T0: i64 = 1_790_000_000_000;
const PW: &str = "violet-Harbor-83-lantern";
const PW2: &str = "copper-Meadow-41-ribbon";
const KEY: [u8; 32] = [7; 32];

struct Fixture {
    dir: tempfile::TempDir,
    clock: Arc<ManualClock>,
    device: Arc<FakeDevice>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            clock: Arc::new(ManualClock::new(T0)),
            device: Arc::new(FakeDevice::new(Some(DeviceKind::TouchId), true)),
        }
    }

    fn session_with(&self, seal: Box<dyn OsSeal>) -> Session<SqliteStore> {
        let mut config = Config::new(
            Paths::in_dir(self.dir.path()),
            Box::new(self.clock.clone()),
            Box::new(SeededRng::new(5)),
            seal,
            Box::new(self.device.clone()),
        );
        config.cost = Argon2Cost { m: 64, t: 1, p: 1 };
        Session::new(config)
    }

    fn session(&self) -> Session<SqliteStore> {
        let mut s = self.session_with(Box::new(FileSeal::new(KEY)));
        s.init(None);
        s
    }

    fn account_json(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.dir.path().join("account.json")).unwrap()).unwrap()
    }

    /// The decrypted account.
    fn account(&self) -> Value {
        let file = self.account_json();
        let data = kb_crypto::encoding::base64_decode(file["data"].as_str().unwrap()).unwrap();
        serde_json::from_slice(&FileSeal::new(KEY).unseal(&data).unwrap()).unwrap()
    }
}

fn input(password: Option<&str>, code: Option<&str>, remember: bool) -> UnlockInput {
    UnlockInput { password: password.map(|p| Zeroizing::new(p.to_owned())), code: code.map(|c| Zeroizing::new(c.to_owned())), remember }
}

fn pw_input(p: &str) -> UnlockInput {
    input(Some(p), None, false)
}

fn code_of(secret_grouped: &str, at_ms: i64) -> String {
    kb_crypto::totp::totp_at(&secret_grouped.replace(' ', ""), at_ms / 1000, 6).unwrap()
}

fn setup_password(f: &Fixture) -> (Session<SqliteStore>, String) {
    let mut s = f.session();
    let key = s.setup(AuthMode::Password, Some(PW)).unwrap().to_string();
    (s, key)
}

#[test]
fn setup_writes_the_account_file_like_the_app_and_opens_the_database() {
    let f = Fixture::new();
    let mut s = f.session();
    assert_eq!(s.status().state, "setup");
    let key = s.setup(AuthMode::Password, Some(PW)).unwrap();
    assert_eq!(key.split('-').count(), 8);
    assert!(s.is_unlocked() && s.db().is_ok() && s.setup_flow_active());
    let file = f.account_json();
    assert!(serde_json::to_string(&file).unwrap().starts_with(r#"{"format":"kasboek-account","version":2,"seal":"os","data":""#));
    let account = f.account();
    let keys: Vec<&str> = account.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["version", "mode", "createdAt", "twoFactor", "slots", "vault", "attempts"]);
    assert_eq!(account["createdAt"], "2026-09-21T14:13:20.000Z");
    let slots: Vec<&str> = account["slots"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(slots, ["recovery", "password"]);
    assert_eq!(account["attempts"], json!({"failed": 0, "lastFailedAt": null}));
    // A second setup is refused, also from a fresh session.
    assert_eq!(s.setup(AuthMode::Password, Some(PW)).unwrap_err().code, "auth.exists");
    assert_eq!(f.session().setup(AuthMode::Password, Some(PW)).unwrap_err().code, "auth.exists");
}

#[test]
fn setup_refuses_weak_passwords_and_missing_device_protection() {
    let f = Fixture::new();
    let mut s = f.session();
    assert_eq!(s.setup(AuthMode::Password, Some("short")).unwrap_err().code, "auth.weak_password");
    assert_eq!(s.status().state, "setup");
    let mut weak = f.session_with(Box::new(FileSeal::weak(KEY)));
    weak.init(None);
    assert_eq!(weak.setup(AuthMode::Device, None).unwrap_err().code, "auth.device_unprotected");
    f.device.set(None, true);
    assert_eq!(s.setup(AuthMode::Device, None).unwrap_err().code, "auth.no_device");
    f.device.set(Some(DeviceKind::TouchId), false);
    assert_eq!(s.setup(AuthMode::Device, None).unwrap_err().code, "auth.device_failed");
}

#[test]
fn lock_and_unlock_with_the_password_and_count_wrong_ones() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    s.set_event_sink(move |e| sink.lock().unwrap().push(e));
    s.lock(LockReason::User, false);
    assert_eq!(*events.lock().unwrap(), [Event::Locked(LockReason::User)]);
    assert_eq!(s.status().state, "locked");
    assert_eq!(s.db().err().unwrap().code, "auth.locked");
    assert_eq!(s.unlock(&pw_input("wrong password here")).unwrap_err().message, "The password is incorrect.");
    assert_eq!(f.account()["attempts"]["failed"], 1);
    s.unlock(&pw_input(PW)).unwrap();
    assert!(s.is_unlocked());
    assert_eq!(f.account()["attempts"], json!({"failed": 0, "lastFailedAt": null}));
    // A strong password does not raise weakPassword.
    assert!(!s.status().weak_password);
}

#[test]
fn throttle_is_5_free_tries_then_doubling_up_to_15_minutes() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.lock(LockReason::User, false);
    for _ in 0..5 {
        assert_eq!(s.unlock(&pw_input("wrong password here")).unwrap_err().code, "auth.failed");
    }
    assert_eq!(s.status().throttle_seconds, 30);
    let e = s.unlock(&pw_input(PW)).unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("auth.throttled", "Too many attempts. Try again in 30 seconds."));
    f.clock.advance(29_001);
    assert_eq!(s.status().throttle_seconds, 1);
    f.clock.advance(999);
    assert_eq!(s.status().throttle_seconds, 0);
    for expected in [60, 120, 240, 480, 900, 900] {
        assert_eq!(s.unlock(&pw_input("wrong password here")).unwrap_err().code, "auth.failed");
        assert_eq!(s.status().throttle_seconds, expected);
        f.clock.advance(expected as i64 * 1000);
    }
    s.unlock(&pw_input(PW)).unwrap();
    assert_eq!(s.status().throttle_seconds, 0);
}

#[test]
fn recovery_key_unlocks_marks_recovered_and_allows_a_password_change_without_the_old_one() {
    let f = Fixture::new();
    let (mut s, key) = setup_password(&f);
    s.lock(LockReason::User, false);
    assert_eq!(s.unlock_recovery("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH").unwrap_err().message, "That recovery key is not correct.");
    s.unlock_recovery(&key.to_lowercase().replace('-', " ")).unwrap();
    assert!(s.status().recovered);
    assert_eq!(s.change_password(None, "short").unwrap_err().code, "auth.weak_password");
    s.change_password(None, PW2).unwrap();
    assert!(!s.status().recovered);
    s.lock(LockReason::User, false);
    assert_eq!(s.unlock(&pw_input(PW)).unwrap_err().code, "auth.failed");
    s.unlock(&pw_input(PW2)).unwrap();
}

#[test]
fn sensitive_changes_need_the_current_password_and_count_mistakes() {
    let f = Fixture::new();
    let (mut s, key) = setup_password(&f);
    assert_eq!(s.change_password(Some("nope nope nope"), PW2).unwrap_err().message, "The current password is incorrect.");
    assert_eq!(f.account()["attempts"]["failed"], 1);
    assert_eq!(s.new_recovery_key(None).unwrap_err().code, "auth.failed");
    let fresh = s.new_recovery_key(Some(PW)).unwrap();
    assert_eq!(f.account()["attempts"]["failed"], 0);
    s.lock(LockReason::User, false);
    assert_eq!(s.unlock_recovery(&key).unwrap_err().code, "auth.failed");
    s.unlock_recovery(&fresh).unwrap();
    assert_eq!(s.change_password(Some("x"), PW2).ok(), Some(()), "a recovered session needs no current password");
}

#[test]
fn two_factor_enable_unlock_remember_and_disable() {
    let f = Fixture::new();
    let (mut s, key) = setup_password(&f);
    assert_eq!(s.totp_enable("123456").unwrap_err().code, "auth.totp_expired");
    let (secret, uri, _) = s.totp_begin().unwrap();
    assert!(uri.starts_with("otpauth://totp/Kasboek%3AKasboek?secret="));
    assert_eq!(s.totp_enable("000000").unwrap_err().message, "That code is not correct. Check the time on your phone and try again.");
    s.totp_enable(&code_of(&secret, T0)).unwrap();
    assert_eq!(f.account()["twoFactor"], true);
    s.lock(LockReason::User, false);
    let status = s.status();
    assert!(status.two_factor && status.remembered_until.is_none());
    // Missing, wrong and re-used codes all fail with the same text.
    for code in [None, Some("000000".to_string()), Some(code_of(&secret, T0))] {
        let e = s.unlock(&input(Some(PW), code.as_deref(), false)).unwrap_err();
        assert_eq!(e.message, "The password or code is incorrect.");
    }
    f.clock.advance(30_000 * 3);
    s.unlock(&input(Some(PW), Some(&code_of(&secret, f.clock_ms())), true)).unwrap();
    let until = s.status().remembered_until.unwrap();
    assert_eq!(until, "2026-10-21T14:14:50.000Z");
    s.lock(LockReason::User, false);
    s.unlock(&pw_input(PW)).unwrap(); // remembered: no code
    s.lock(LockReason::User, false);
    f.clock.advance(30 * 86_400_000);
    assert!(s.status().remembered_until.is_none());
    assert_eq!(s.unlock(&pw_input(PW)).unwrap_err().code, "auth.failed");
    // The recovery key replaces password and code; disabling after recovery needs no code.
    s.unlock_recovery(&key).unwrap();
    s.totp_disable("").unwrap();
    assert_eq!(f.account()["twoFactor"], false);
    assert!(f.account()["vault"].is_object() && f.account().get("remember2fa").is_none());
}

#[test]
fn passwordless_switch_and_the_sealed_state_of_a_locked_device_account() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    assert_eq!(s.switch_to_passwordless(Some("wrong wrong wrong")).unwrap_err().code, "auth.failed");
    f.device.set(Some(DeviceKind::TouchId), false);
    assert_eq!(s.switch_to_passwordless(Some(PW)).unwrap_err().code, "auth.device_failed");
    f.device.set(Some(DeviceKind::TouchId), true);
    s.switch_to_passwordless(Some(PW)).unwrap();
    let slots: Vec<String> = f.account()["slots"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(slots, ["recovery", "device"]);
    s.lock(LockReason::User, false);
    let status = s.status();
    assert_eq!((status.state, status.mode, status.device), ("locked", Some("device"), Some("touch-id")));
    // A cancelled prompt leaves the lock screen as it was.
    f.device.set(Some(DeviceKind::TouchId), false);
    assert_eq!(s.unlock(&UnlockInput::default()).unwrap_err().code, "auth.device_failed");
    f.device.set(Some(DeviceKind::TouchId), true);
    s.unlock(&UnlockInput::default()).unwrap();
    assert_eq!(s.status().state, "unlocked");
    // Back to a password needs no current password and no device.
    s.change_password(None, PW2).unwrap();
    assert_eq!(f.account()["mode"], "password");
    assert!(f.account()["slots"].get("device").is_none());
}

#[test]
fn a_device_account_is_not_unsealed_before_the_device_check_when_a_hint_is_given() {
    let f = Fixture::new();
    let mut s = f.session();
    s.setup(AuthMode::Device, None).unwrap();
    s.lock(LockReason::User, false);
    // A second start-up with the hint of the last unlock: the seal is not opened (a wrong seal key would fail).
    let mut cold = f.session_with(Box::new(FileSeal::new([9; 32])));
    let hint = Hint {
        mode: AuthMode::Device,
        two_factor: false,
        remembered_until: None,
        attempts: kb_session::account::Attempts { failed: 0, last_failed_at: None },
    };
    cold.init(Some(hint));
    let status = cold.status();
    assert_eq!((status.state, status.mode, status.error.is_none()), ("locked", Some("device"), true));
    // Without the hint the same start-up reports the seal problem.
    let mut plain = f.session_with(Box::new(FileSeal::new([9; 32])));
    plain.init(None);
    assert_eq!(plain.status().error.unwrap().code, "auth.other_device");
    // The prompt comes first; only then is the file opened (and here it cannot be).
    assert_eq!(cold.unlock(&UnlockInput::default()).unwrap_err().code, "auth.other_device");
    assert_eq!(f.device.asked(), ["Set up Kasboek", "Unlock Kasboek"]);
}

#[test]
fn device_unlock_checks_the_code_format_before_asking_for_the_prompt() {
    let f = Fixture::new();
    let mut s = f.session();
    s.setup(AuthMode::Device, None).unwrap();
    let (secret, _, _) = s.totp_begin().unwrap();
    s.totp_enable(&code_of(&secret, T0)).unwrap();
    s.lock(LockReason::User, false);
    let asked = f.device.asked().len();
    assert_eq!(s.unlock(&input(None, Some("12"), false)).unwrap_err().code, "auth.code_required");
    assert_eq!(f.device.asked().len(), asked);
    f.clock.advance(120_000);
    s.unlock(&input(None, Some(&code_of(&secret, f.clock_ms())), false)).unwrap();
}

#[test]
fn erase_moves_the_data_aside_and_restore_brings_it_back() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    std::fs::create_dir(f.dir.path().join("safety-backups")).unwrap();
    std::fs::write(f.dir.path().join("safety-backups/a.kasboek"), b"x").unwrap();
    s.erase().unwrap();
    assert_eq!(s.status().state, "setup");
    let erased = s.status().erased;
    assert_eq!(erased.len(), 1);
    assert_eq!(erased[0].name, T0.to_string());
    assert!(!f.dir.path().join("account.json").exists() && !f.dir.path().join("kasboek.db").exists());
    // A new setup, then restoring is blocked.
    s.setup(AuthMode::Password, Some(PW2)).unwrap();
    assert_eq!(s.restore_erased_data(&T0.to_string()).unwrap_err().code, "auth.restore_blocked");
    s.erase().unwrap();
    // Two erases in the same millisecond get different entries.
    let names: Vec<String> = s.status().erased.into_iter().map(|e| e.name).collect();
    assert_eq!(names, [(T0 + 1).to_string(), T0.to_string()]);
    assert_eq!(s.restore_erased_data("12").unwrap_err().code, "auth.nothing_erased");
    s.restore_erased_data(&names[1]).unwrap();
    assert_eq!(s.status().state, "locked");
    s.unlock(&pw_input(PW)).unwrap();
    assert!(f.dir.path().join("safety-backups/a.kasboek").exists());
}

#[test]
fn erased_copies_are_purged_after_30_days() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.erase().unwrap();
    assert_eq!(s.status().erased.len(), 1);
    f.clock.advance(30 * 86_400_000 - 1);
    s.init(None);
    assert_eq!(s.status().erased.len(), 1);
    f.clock.advance(1);
    s.init(None);
    assert!(s.status().erased.is_empty());
    assert!(!f.dir.path().join("erased").join(T0.to_string()).exists());
}

#[test]
fn an_erased_folder_with_an_absurd_name_does_not_panic_the_purge() {
    let f = Fixture::new();
    for name in ["9223372036854775808", "9223372036854775807", "18446744073709551615"] {
        let dir = f.dir.path().join("erased").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kasboek.db"), b"x").unwrap();
        std::fs::write(dir.join("account.json"), b"x").unwrap();
    }
    let mut s = f.session();
    s.init(None);
    // Dates far in the future are never old enough, so the folders stay.
    assert_eq!(s.status().erased.len(), 3);
}

#[test]
fn legacy_keystore_is_migrated_at_setup() {
    let f = Fixture::new();
    let dir = f.dir.path();
    // Create a database with a known key, and the Phase 1 key file for it.
    let key_hex = "ab".repeat(32);
    {
        use kb_db::{DbKey, OpenOptions, Store};
        SqliteStore::open(&dir.join("kasboek.db"), &DbKey::from_hex(&key_hex).unwrap(), OpenOptions::default()).unwrap();
    }
    let plain = format!("plain:{}", kb_crypto::encoding::base64_encode(key_hex.as_bytes()));
    std::fs::write(dir.join("keystore.json"), json!({ "dbKey": plain }).to_string()).unwrap();
    let mut s = f.session();
    assert!(s.status().legacy_data);
    s.setup(AuthMode::Password, Some(PW)).unwrap();
    assert!(!dir.join("keystore.json").exists());
    assert!(!std::fs::read_dir(dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("orphaned")));
    s.lock(LockReason::User, false);
    s.unlock(&pw_input(PW)).unwrap();
    // os: prefix goes through the seal.
    let sealed = FileSeal::new(KEY).seal(key_hex.as_bytes()).unwrap();
    assert_eq!(sealed.len(), 12 + 64 + 16);
}

#[test]
fn an_orphaned_database_is_moved_aside_at_setup() {
    let f = Fixture::new();
    std::fs::write(f.dir.path().join("kasboek.db"), b"not a database of ours").unwrap();
    let mut s = f.session();
    s.setup(AuthMode::Password, Some(PW)).unwrap();
    assert!(f.dir.path().join(format!("kasboek.db.orphaned-{T0}")).exists());
}

#[test]
fn an_unreadable_account_is_locked_with_an_error_never_setup() {
    let f = Fixture::new();
    setup_password(&f);
    for (bytes, code) in [
        (b"{not json".to_vec(), "auth.corrupt"),
        (br#"{"format":"other","version":2,"seal":"none","data":""}"#.to_vec(), "auth.corrupt"),
        (br#"{"format":"kasboek-account","version":2,"seal":"os","data":"AAAA"}"#.to_vec(), "auth.other_device"),
        (br#"{"format":"kasboek-account","version":2,"seal":"none","data":"e30"}"#.to_vec(), "auth.other_device"),
    ] {
        std::fs::write(f.dir.path().join("account.json"), bytes).unwrap();
        // (A failed re-read keeps the account already in memory, as in the app; a fresh start has none.)
        let mut s = f.session();
        let status = s.status();
        assert_eq!((status.state, status.error.map(|e| e.code)), ("locked", Some(code.to_string())));
        assert_eq!(s.setup(AuthMode::Password, Some(PW)).unwrap_err().code, "auth.exists");
        assert_eq!(s.unlock(&pw_input(PW)).unwrap_err().code, code);
    }
}

#[test]
fn an_oversized_account_file_is_refused_unread() {
    let f = Fixture::new();
    std::fs::write(f.dir.path().join("account.json"), vec![b' '; 1024 * 1024 + 1]).unwrap();
    let mut s = f.session();
    assert_eq!(s.status().error.unwrap().code, "auth.corrupt");
}

#[test]
fn without_an_os_seal_the_file_is_written_as_none_and_device_mode_is_refused() {
    let f = Fixture::new();
    let mut s = f.session_with(Box::new(Unsupported));
    s.init(None);
    assert_eq!(s.status().key_protection, "weak");
    s.setup(AuthMode::Password, Some(PW)).unwrap();
    assert_eq!(f.account_json()["seal"], "none");
    assert_eq!(s.switch_to_passwordless(Some(PW)).unwrap_err().code, "auth.device_unprotected");
}

#[test]
fn auto_lock_and_system_lock() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.auto_lock_tick(59, 1);
    assert!(s.is_unlocked());
    s.auto_lock_tick(1000, 0);
    assert!(s.is_unlocked());
    s.auto_lock_tick(60, 1);
    assert!(!s.is_unlocked());
    s.unlock(&pw_input(PW)).unwrap();
    s.on_system_lock();
    assert!(!s.is_unlocked());
}

#[test]
fn account_file_written_by_a_newer_version_keeps_its_extra_fields() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    let mut account = f.account();
    account["future"] = json!({"x": 1});
    let data = kb_crypto::encoding::base64_encode(&FileSeal::new(KEY).seal(account.to_string().as_bytes()).unwrap());
    std::fs::write(f.dir.path().join("account.json"), json!({"format":"kasboek-account","version":2,"seal":"os","data":data}).to_string())
        .unwrap();
    s.lock(LockReason::User, false);
    s.init(None);
    s.unlock(&pw_input(PW)).unwrap();
    assert_eq!(f.account()["future"], json!({"x": 1}));
}

#[test]
fn ops_validate_like_the_contract_and_answer_with_the_status() {
    let f = Fixture::new();
    let mut s = f.session();
    let ops = register_ops::<SqliteStore>();
    let call = |s: &mut Session<SqliteStore>, name: &str, input: Value| -> Result<Value, String> {
        let spec = ops.iter().find(|o| o.name == name).unwrap();
        (spec.handler)(s, input).map_err(|e| e.code)
    };
    assert_eq!(call(&mut s, "auth.status", json!({})).unwrap()["state"], "setup");
    assert_eq!(call(&mut s, "auth.status", json!({"x": 1})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.setup", json!({"mode": "password", "password": "short"})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.setup", json!({"mode": "device", "password": PW})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.setup", json!({"mode": "none"})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.exists", json!({})).unwrap(), json!(false));
    let key = call(&mut s, "auth.setup", json!({"mode": "password", "password": PW})).unwrap()["recoveryKey"].as_str().unwrap().to_owned();
    assert_eq!(call(&mut s, "auth.lock", json!({})).unwrap()["state"], "locked");
    assert_eq!(call(&mut s, "auth.unlock", json!({"password": "x".repeat(257)})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.unlock", json!({"password": "nope"})).unwrap_err(), "auth.failed");
    assert_eq!(call(&mut s, "auth.unlockRecovery", json!({"recoveryKey": "short"})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.unlockRecovery", json!({"recoveryKey": key})).unwrap()["recovered"], true);
    assert_eq!(call(&mut s, "auth.totpEnable", json!({"code": "12 3456"})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.erase", json!({"confirm": "erase"})).unwrap_err(), "op.invalid_input");
    assert_eq!(call(&mut s, "auth.restoreErased", json!({"name": "12"})).unwrap_err(), "op.invalid_input");
    let names: Vec<&str> = ops.iter().filter(|o| o.in_contract).map(|o| o.name).collect();
    assert_eq!(names.len(), 14);
}

fn device_hint(failed: u64) -> Hint {
    Hint {
        mode: AuthMode::Device,
        two_factor: false,
        remembered_until: None,
        attempts: kb_session::account::Attempts { failed, last_failed_at: (failed > 0).then(|| "2026-09-21T14:13:20.000Z".to_owned()) },
    }
}

#[test]
fn a_stale_device_hint_does_not_lock_out_the_password() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.lock(LockReason::User, false);
    // The prefs say "device" (stale or edited) but the account is a password account. With a device present and without.
    for kind in [Some(DeviceKind::TouchId), None] {
        f.device.set(kind, true);
        let mut cold = f.session_with(Box::new(FileSeal::new(KEY)));
        cold.init(Some(device_hint(0)));
        assert_eq!(cold.status().mode, Some("device"));
        assert_eq!(cold.unlock(&pw_input("wrong password here")).unwrap_err().message, "The password is incorrect.");
        cold.unlock(&pw_input(PW)).unwrap();
        assert!(cold.is_unlocked());
        assert_eq!(cold.status().mode, Some("password"));
    }
    assert!(f.device.asked().is_empty(), "the device check is never asked for a password account");
}

#[test]
fn a_password_sent_to_a_real_device_account_still_needs_the_device_check() {
    let f = Fixture::new();
    let mut s = f.session();
    s.setup(AuthMode::Device, None).unwrap();
    s.lock(LockReason::User, false);
    let mut cold = f.session_with(Box::new(FileSeal::new(KEY)));
    cold.init(Some(device_hint(0)));
    f.device.set(Some(DeviceKind::TouchId), false);
    assert_eq!(cold.unlock(&pw_input(PW)).unwrap_err().code, "auth.device_failed");
    assert!(!cold.is_unlocked());
    f.device.set(Some(DeviceKind::TouchId), true);
    cold.unlock(&pw_input(PW)).unwrap();
}

#[test]
fn a_hint_for_a_device_account_without_a_device_is_corrected_not_trusted() {
    let f = Fixture::new();
    let mut s = f.session();
    s.setup(AuthMode::Device, None).unwrap();
    s.lock(LockReason::User, false);
    f.device.set(None, true);
    let mut cold = f.session_with(Box::new(FileSeal::new(KEY)));
    cold.init(Some(device_hint(0)));
    assert_eq!(cold.unlock(&UnlockInput::default()).unwrap_err().code, "auth.no_device");
}

#[test]
fn reauth_and_the_changes_that_use_it_need_an_unlocked_session() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.lock(LockReason::User, false);
    assert_eq!(s.reauth(Some(PW)).unwrap_err().code, "auth.locked");
    assert_eq!(s.reauth(None).unwrap_err().code, "auth.locked");
    assert_eq!(f.account()["attempts"]["failed"], 0, "a locked reauth counts nothing");
    s.unlock(&pw_input(PW)).unwrap();
    s.reauth(Some(PW)).unwrap();
}

#[test]
fn a_recovery_attempt_while_throttled_is_refused_before_the_seal_is_opened() {
    let f = Fixture::new();
    let mut s = f.session();
    s.setup(AuthMode::Device, None).unwrap();
    s.lock(LockReason::User, false);
    // Another seal key: opening the file would say other_device.
    let mut cold = f.session_with(Box::new(FileSeal::new([9; 32])));
    cold.init(Some(device_hint(7)));
    f.clock.set(T0 - 1000);
    let e = cold.unlock_recovery("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH").unwrap_err();
    assert_eq!(e.code, "auth.throttled");
}

#[test]
fn clock_set_back_does_not_lock_the_account_out_for_longer_than_the_delay() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    s.lock(LockReason::User, false);
    for _ in 0..5 {
        s.unlock(&pw_input("wrong password here")).unwrap_err();
    }
    // The failures are dated "now"; the clock then jumps back a year.
    f.clock.set(T0 - 365 * 86_400_000);
    assert_eq!(s.status().throttle_seconds, 30);
    f.clock.advance(30_000);
    assert_eq!(s.status().throttle_seconds, 30, "still a year before the failures, but never more than the delay");
}

impl Fixture {
    fn clock_ms(&self) -> i64 {
        use kb_session::time::Clock;
        self.clock.now_ms()
    }
}

fn plant_electron_backup(f: &Fixture) -> std::path::PathBuf {
    let path = f.dir.path().join("account.electron.json");
    std::fs::write(&path, b"{\"invented\":\"electron original\"}").unwrap();
    path
}

#[test]
fn the_electron_backup_goes_after_the_first_native_unlock_that_saved() {
    let f = Fixture::new();
    let (mut s, key) = setup_password(&f);
    s.lock(LockReason::User, false);
    let backup = plant_electron_backup(&f);
    // Starting, looking at the lock screen and a wrong password keep it.
    let mut s = f.session();
    assert_eq!(s.status().state, "locked");
    assert_eq!(s.unlock(&pw_input("nope nope nope")).unwrap_err().code, "auth.failed");
    assert!(backup.exists());
    s.unlock(&pw_input(PW)).unwrap();
    assert!(!backup.exists());
    // The recovery key counts as an unlock too.
    s.lock(LockReason::User, false);
    let backup = plant_electron_backup(&f);
    s.unlock_recovery(&key).unwrap();
    assert!(!backup.exists());
}

#[test]
fn credential_changes_remove_the_electron_backup() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    let backup = plant_electron_backup(&f);
    s.change_password(Some(PW), PW2).unwrap();
    assert!(!backup.exists(), "password change");
    let backup = plant_electron_backup(&f);
    s.new_recovery_key(Some(PW2)).unwrap();
    assert!(!backup.exists(), "recovery key rotation");
    let (secret, _, _) = s.totp_begin().unwrap();
    let backup = plant_electron_backup(&f);
    s.totp_enable(&code_of(&secret, T0)).unwrap();
    assert!(!backup.exists(), "2FA on");
    let backup = plant_electron_backup(&f);
    f.clock.advance(30_000);
    s.totp_disable(&code_of(&secret, T0 + 30_000)).unwrap();
    assert!(!backup.exists(), "2FA off");
}

#[test]
fn erase_and_restore_carry_the_electron_backup_and_never_overwrite_a_live_one() {
    let f = Fixture::new();
    let (mut s, _) = setup_password(&f);
    let backup = plant_electron_backup(&f);
    s.erase().unwrap();
    assert!(!backup.exists());
    let name = s.status().erased[0].name.clone();
    assert!(f.dir.path().join("erased").join(&name).join("account.electron.json").exists());
    // A stray live copy (no account here) is kept aside, not overwritten.
    std::fs::write(&backup, b"stray").unwrap();
    s.restore_erased_data(&name).unwrap();
    assert!(std::fs::read(&backup).unwrap().starts_with(b"{\"invented\""));
    let orphan = f.dir.path().join(format!("account.electron.json.orphaned-{T0}"));
    assert_eq!(std::fs::read(orphan).unwrap(), b"stray");
}
