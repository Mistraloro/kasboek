//! `transfer.*` and `backup.*` through the service: export and import between two data folders (password, recovery key,
//! 2FA, passwordless), what an import resets, the refusals, the retention tiers and local-time names on a fixed clock, the
//! automatic backups and their events, and a database replaced while another job runs. Everything here is invented data.
use kb_core::backup_tiers::{stamp, FixedZone, LocalZone};
use kb_crypto::slot::Argon2Cost;
use kb_crypto::transfer::{encode_transfer, open_transfer, AuthMode, Credential, TransferInput, TransferKind};
use kb_db::Store;
use kb_service::{block_on, AppError, AppEvent, AppService, BackupTiming, CoreOptions, CoreService, FakeDesktop, JobCtx};
use kb_session::seal::FileSeal;
use kb_session::time::ManualClock;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const T0: i64 = 1_794_650_400_000; // 2026-11-14T10:00:00Z
const PASSWORD_A: &str = "Tulip-Harbour-Lantern-48";
const PASSWORD_B: &str = "Copper-Meadow-Ribbon-41";

struct Rig {
    service: CoreService,
    dir: tempfile::TempDir,
    clock: Arc<ManualClock>,
    recovery_key: String,
    events: Arc<Mutex<Vec<AppEvent>>>,
}

fn rig_with(password: &str, answers: Vec<Option<PathBuf>>, tweak: impl FnOnce(&mut CoreOptions)) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(T0));
    let mut options = CoreOptions::new(dir.path().to_path_buf());
    options.seal = Box::new(FileSeal::new([3; 32]));
    options.clock = Some(clock.clone());
    options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
    options.desktop = Arc::new(FakeDesktop::new(answers));
    options.backup_zone = Arc::new(FixedZone(0));
    tweak(&mut options);
    let service = CoreService::open(options).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    service.subscribe(Arc::new(move |e| sink.lock().unwrap().push(e)));
    let setup = call(&service, "auth.setup", json!({ "mode": "password", "password": password })).unwrap();
    let recovery_key = setup["recoveryKey"].as_str().unwrap().to_owned();
    Rig { service, dir, clock, recovery_key, events }
}

fn rig(password: &str, answers: Vec<Option<PathBuf>>) -> Rig {
    rig_with(password, answers, |_| {})
}

fn call(service: &CoreService, op: &str, input: Value) -> Result<Value, AppError> {
    block_on(service.invoke(op, input))
}

impl Rig {
    fn call(&self, op: &str, input: Value) -> Result<Value, AppError> {
        call(&self.service, op, input)
    }

    fn account(&self, name: &str) {
        self.call("accounts.create", json!({ "name": name, "bank": "Invented Bank", "openingBalanceCents": 1000 })).unwrap();
    }

    fn names(&self) -> Vec<String> {
        let list = self.call("accounts.list", json!({})).unwrap();
        list.as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap().to_owned()).collect()
    }

    fn audit(&self) -> Vec<(String, String)> {
        self.service
            .with_core(|w| {
                let tables = w.core().db()?.dump_tables()?;
                let t = tables.iter().find(|t| t.name == "audit_log").unwrap();
                let (a, d) =
                    (t.columns.iter().position(|c| c == "action").unwrap(), t.columns.iter().position(|c| c == "details").unwrap());
                let text = |c: &kb_db::Cell| if let kb_db::Cell::Text(s) = c { s.clone() } else { String::new() };
                Ok::<_, AppError>(t.rows.iter().map(|r| (text(&r[a]), text(&r[d]))).collect())
            })
            .unwrap()
            .unwrap()
    }

    fn setting(&self, key: &'static str) -> Value {
        self.service.with_core(move |w| kb_core::settings::get_settings(w.core().db()?).map(|s| s[key].clone())).unwrap().unwrap()
    }

    fn set_settings(&self, patch: Value) {
        let Value::Object(map) = patch else { panic!() };
        self.service.with_core(move |w| kb_core::settings::update_settings(w.core().db()?, &map).map(|_| ())).unwrap().unwrap();
    }

    fn files(&self, sub: &str) -> Vec<String> {
        names_in(&self.dir.path().join(sub))
    }

    fn events(&self) -> Vec<AppEvent> {
        self.events.lock().unwrap().clone()
    }
}

/// The files in a folder, sorted, without the `.partial` of a write that is going on.
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).map(|d| d.map(|e| e.unwrap().file_name().into_string().unwrap()).collect()).unwrap_or_default();
    names.retain(|n| !n.ends_with(".partial"));
    names.sort();
    names
}

/// Exports `from` to a file in `dir` (the desktop of `from` must answer with that path).
fn export(from: &Rig, file: &Path) -> Value {
    let done = from.call("transfer.export", json!({})).unwrap();
    assert_eq!(done["file"], file.to_string_lossy().as_ref());
    done
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn export_then_import_moves_the_data_and_the_login() {
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone())]);
    a.account("Checking");
    export(&a, &file);
    assert_eq!(&std::fs::read(&file).unwrap()[..8], b"KASBOEK2");
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);
    // No `.partial` or snapshot is left, and the audit entry has no details.
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
    assert!(a.files("").iter().all(|n| !n.starts_with("snapshot-")));
    assert_eq!(a.audit().last().unwrap(), &("transfer.export".to_owned(), "{}".to_owned()));

    let b = rig(PASSWORD_B, vec![Some(file.clone())]);
    b.account("Other");
    let picked = b.call("transfer.pick", json!({})).unwrap();
    assert_eq!(picked["fileName"], "a.kasboek");
    assert_eq!(picked["kind"], "export");
    assert_eq!(picked["mode"], "password");
    assert_eq!(picked["hasPassword"], true);
    assert_eq!(picked["twoFactor"], false);
    assert_eq!(picked["needsNewPassword"], false);
    let token = picked["token"].as_str().unwrap();

    let done = b.call("transfer.import", json!({ "token": token, "password": PASSWORD_A })).unwrap();
    assert_eq!(done["status"]["state"], "unlocked");
    assert_eq!(done["status"]["recovered"], false);
    assert_eq!(b.names(), ["Checking"]);
    // A safety copy of what was here is kept, the import is in the audit log, and nothing is left over.
    assert_eq!(b.files("safety-backups").len(), 1);
    assert!(b.files("safety-backups")[0].starts_with("before-import-2026-11-14_100000"));
    assert!(b.audit().contains(&("transfer.import".to_owned(), "{}".to_owned())));
    assert!(b.files("").iter().all(|n| !n.starts_with("import-") && !n.starts_with("snapshot-") && !n.ends_with(".replaced")));
    // The login is the one of the file.
    call(&b.service, "auth.lock", json!({})).unwrap();
    assert_eq!(call(&b.service, "auth.unlock", json!({ "password": PASSWORD_B })).unwrap_err().code, "auth.failed");
    call(&b.service, "auth.unlock", json!({ "password": PASSWORD_A })).unwrap();
    assert_eq!(b.names(), ["Checking"]);
    // The token is spent.
    assert_eq!(b.call("transfer.import", json!({ "token": token, "password": PASSWORD_A })).unwrap_err().code, "transfer.expired");
}

#[test]
fn wrong_credentials_change_nothing_and_the_recovery_key_works() {
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone())]);
    a.account("Checking");
    export(&a, &file);
    let b = rig(PASSWORD_B, vec![Some(file.clone())]);
    b.account("Other");
    let token = b.call("transfer.pick", json!({})).unwrap()["token"].as_str().unwrap().to_owned();
    for input in [
        json!({ "token": token, "password": "wrong password 12" }),
        json!({ "token": token }),
        json!({ "token": token, "recoveryKey": "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723" }),
    ] {
        assert_eq!(b.call("transfer.import", input).unwrap_err().code, "transfer.wrong_credentials");
    }
    assert_eq!(b.call("transfer.import", json!({ "token": "nope", "password": PASSWORD_A })).unwrap_err().code, "transfer.expired");
    assert_eq!(b.names(), ["Other"]);
    assert!(b.files("").iter().all(|n| !n.starts_with("import-")));
    assert!(b.files("safety-backups").is_empty());

    // The recovery key as typed (lower case), and the password is then the one to change.
    let key = a.recovery_key.to_lowercase();
    let done = b.call("transfer.import", json!({ "token": token, "recoveryKey": key })).unwrap();
    assert_eq!(done["status"]["recovered"], true);
    assert_eq!(b.names(), ["Checking"]);
}

#[test]
fn two_factor_needs_the_code_unless_the_recovery_key_is_used() {
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone()), Some(file.clone())]);
    a.account("Checking");
    let secret = a.call("auth.totpBegin", json!({})).unwrap()["secret"].as_str().unwrap().replace(' ', "");
    let code = kb_crypto::totp::totp_at(&secret, T0 / 1000, 6).unwrap();
    a.call("auth.totpEnable", json!({ "code": code })).unwrap();
    export(&a, &file);

    let b = rig(PASSWORD_B, vec![Some(file.clone())]);
    let picked = b.call("transfer.pick", json!({})).unwrap();
    assert_eq!(picked["twoFactor"], true);
    let token = picked["token"].as_str().unwrap();
    for input in [
        json!({ "token": token, "password": PASSWORD_A }),
        json!({ "token": token, "password": PASSWORD_A, "code": "000000" }),
        json!({ "token": token, "password": "wrong password 12", "code": code }),
    ] {
        assert_eq!(b.call("transfer.import", input).unwrap_err().code, "transfer.wrong_credentials");
    }
    let done = b.call("transfer.import", json!({ "token": token, "password": PASSWORD_A, "code": code })).unwrap();
    assert_eq!(done["status"]["twoFactor"], true);

    let c = rig(PASSWORD_B, vec![Some(file.clone())]);
    let token = c.call("transfer.pick", json!({})).unwrap()["token"].as_str().unwrap().to_owned();
    c.call("transfer.import", json!({ "token": token, "recoveryKey": a.recovery_key })).unwrap();
}

#[test]
fn files_that_are_not_exports_are_refused_with_their_own_codes() {
    let out = tempfile::tempdir().unwrap();
    let write = |name: &str, bytes: &[u8]| {
        let p = out.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    };
    let files = [
        (write("old.kasboek", b"KASBOEK1\0\0\0\x05{\"a\":1}and more bytes here"), "transfer.old_format"),
        (write("text.kasboek", b"just some text, not an export"), "transfer.not_kasboek"),
        (write("empty.kasboek", b""), "transfer.not_kasboek"),
        (write("short.kasboek", b"KASBOEK2\0\0\0\x00"), "transfer.corrupt"),
        (write("json.kasboek", b"KASBOEK2\0\0\0\x03{} \0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"), "transfer.unsupported"),
    ];
    let b = rig(PASSWORD_B, files.iter().map(|(p, _)| Some(p.clone())).collect());
    for (_, code) in &files {
        assert_eq!(b.call("transfer.pick", json!({})).unwrap_err().code, *code);
    }
    // A dialog that was cancelled picks nothing.
    assert_eq!(b.call("transfer.pick", json!({})).unwrap(), Value::Null);
}

#[test]
fn an_import_drops_what_a_file_from_elsewhere_must_not_bring() {
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone())]);
    a.set_settings(json!({
        "aiBaseUrl": "https://elsewhere.example",
        "autoBackupEnabled": true,
        "autoBackupFolder": "/somewhere/else",
        "hideAccountNumbers": false,
        "assistantEnabled": true,
        "permissions": { "mode": "auto", "rules": {}, "mcpAlwaysAsk": false },
        "memoryEnabled": false,
    }));
    export(&a, &file);

    // This computer has the assistant off: an import never switches it on.
    let b = rig(PASSWORD_B, vec![Some(file.clone()), Some(file.clone())]);
    b.set_settings(json!({ "assistantEnabled": false }));
    let token = b.call("transfer.pick", json!({})).unwrap()["token"].as_str().unwrap().to_owned();
    let done = b.call("transfer.import", json!({ "token": token, "password": PASSWORD_A })).unwrap();
    let reset: Vec<&str> = done["reset"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(reset, ["aiEndpoint", "permissions", "autoBackup", "memory"]);
    assert_eq!(b.setting("assistantEnabled"), false);
    assert_eq!(b.setting("aiBaseUrl"), Value::Null);
    assert_eq!(b.setting("autoBackupEnabled"), false);
    assert_eq!(b.setting("autoBackupFolder"), Value::Null);
    assert_eq!(b.setting("hideAccountNumbers"), true);
    assert_eq!(b.setting("memoryEnabled"), true);
    assert_eq!(b.setting("permissions")["mode"], "ask");

    // With it on, the value in the file stays (here: on).
    let c = rig(PASSWORD_B, vec![Some(file.clone())]);
    let token = c.call("transfer.pick", json!({})).unwrap()["token"].as_str().unwrap().to_owned();
    c.call("transfer.import", json!({ "token": token, "password": PASSWORD_A })).unwrap();
    assert_eq!(c.setting("assistantEnabled"), true);
}

#[test]
fn a_passwordless_export_asks_for_a_password_where_there_is_no_device() {
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let device_file = out.path().join("device.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone())]);
    a.account("Checking");
    export(&a, &file);
    // The same data as a passwordless export (only the recovery slot).
    let opened = open_transfer(&std::fs::read(&file).unwrap(), &Credential::Password { password: PASSWORD_A, code: None }, 0.0).unwrap();
    let recovery_slot = opened.header.slots.recovery.clone();
    let bytes = encode_transfer(&TransferInput {
        kind: TransferKind::Export,
        created_at: "2026-11-14T10:00:00.000Z".into(),
        app_version: "0.0.0".into(),
        schema_version: opened.header.schema_version,
        mode: AuthMode::Device,
        two_factor: false,
        password_slot: None,
        recovery_slot,
        master: &opened.master,
        vault: &opened.vault,
        db_file: &opened.db_file,
    })
    .unwrap();
    std::fs::write(&device_file, bytes).unwrap();

    let b = rig(PASSWORD_B, vec![Some(device_file.clone())]);
    let picked = b.call("transfer.pick", json!({})).unwrap();
    assert_eq!(picked["mode"], "device");
    assert_eq!(picked["hasPassword"], false);
    assert_eq!(picked["needsNewPassword"], true);
    let token = picked["token"].as_str().unwrap();
    let input = |extra: Value| {
        let mut v = json!({ "token": token, "recoveryKey": a.recovery_key });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    assert_eq!(b.call("transfer.import", input(json!({}))).unwrap_err().code, "transfer.needs_new_password");
    assert_eq!(b.call("transfer.import", input(json!({ "newPassword": "short" }))).unwrap_err().code, "op.invalid_input");
    let done = b.call("transfer.import", input(json!({ "newPassword": "Fresh-Meadow-Lantern-77" }))).unwrap();
    assert_eq!(done["status"]["mode"], "password");
    call(&b.service, "auth.lock", json!({})).unwrap();
    call(&b.service, "auth.unlock", json!({ "password": "Fresh-Meadow-Lantern-77" })).unwrap();
    assert_eq!(b.names(), ["Checking"]);
}

#[test]
fn the_page_names_a_backup_never_a_path() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().join("backups");
    std::fs::create_dir(&folder).unwrap();
    let b = rig(PASSWORD_B, vec![Some(folder.clone())]);
    b.account("Checking");
    assert_eq!(b.call("backup.pick", json!({ "name": "kasboek-backup-1.kasboek" })).unwrap_err().code, "backup.not_found");
    b.call("backup.chooseFolder", json!({})).unwrap();
    // A backup that is there can be picked, and imported.
    let made = b.call("backup.runNow", json!({})).unwrap();
    let name = Path::new(made["file"].as_str().unwrap()).file_name().unwrap().to_str().unwrap().to_owned();
    assert_eq!(name, "kasboek-backup-2026-11-14_100000.kasboek");
    std::fs::create_dir(folder.join("kasboek-backup-9.kasboek")).unwrap();
    std::fs::write(out.path().join("kasboek-backup-8.kasboek"), b"outside").unwrap();
    for bad in [
        "../kasboek-backup-8.kasboek",
        "..\\kasboek-backup-8.kasboek",
        "/etc/passwd",
        "kasboek-backup-8.kasboek/../kasboek-backup-8.kasboek",
        "kasboek-backup-1.kasboek",
        "kasboek-backup-9.kasboek",
        "kasboek-backup-.kasboek",
        "kasboek-export-2026-11-14_100000.kasboek",
        "kasboek-backup-2026-11-14_100000.kasboek.partial",
        "kasboek-backup-2026-11-14_100000.kasboek\n",
    ] {
        assert_eq!(b.call("backup.pick", json!({ "name": bad })).unwrap_err().code, "backup.not_found", "{bad:?}");
    }
    for bad in [json!({ "name": "" }), json!({ "name": "x".repeat(201) }), json!({}), json!({ "name": name, "path": "/x" })] {
        assert_eq!(b.call("backup.pick", bad).unwrap_err().code, "op.invalid_input");
    }
    let picked = b.call("backup.pick", json!({ "name": name })).unwrap();
    assert_eq!(picked["kind"], "backup");
    assert_eq!(picked["fileName"], name.as_str());
    b.account("Later");
    let done = b.call("transfer.import", json!({ "token": picked["token"], "password": PASSWORD_B })).unwrap();
    assert_eq!(done["status"]["state"], "unlocked");
    assert_eq!(b.names(), ["Checking"]);
}

#[test]
fn backups_are_thinned_out_by_tier_on_a_fixed_clock() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().to_path_buf();
    let b = rig(PASSWORD_B, vec![Some(folder.clone())]);
    b.call("backup.chooseFolder", json!({})).unwrap();
    const H: i64 = 3_600_000;
    const D: i64 = 24 * H;
    let zone = FixedZone(0);
    let seed = |ago: i64| {
        let name = format!("kasboek-backup-{}.kasboek", stamp(T0 - ago, &zone));
        std::fs::write(folder.join(&name), b"x").unwrap();
        name
    };
    let recent = [seed(H), seed(5 * H)];
    let daily_keep = seed(2 * D);
    let daily_drop = seed(2 * D + 2 * H);
    let monthly_keep = seed(40 * D);
    let monthly_drop = seed(41 * D);
    let ancient = seed(400 * D);
    // Someone else's files are never touched, listed, or counted.
    std::fs::write(folder.join("notes.txt"), b"mine").unwrap();
    std::fs::write(folder.join("kasboek-export-2026-01-01_000000.kasboek"), b"mine").unwrap();

    let made = b.call("backup.runNow", json!({})).unwrap();
    let new = Path::new(made["file"].as_str().unwrap()).file_name().unwrap().to_str().unwrap().to_owned();
    assert_eq!(new, "kasboek-backup-2026-11-14_100000.kasboek");
    let list = b.call("backup.list", json!({})).unwrap();
    let rows: Vec<(String, String)> =
        list.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().to_owned(), e["tier"].as_str().unwrap().to_owned())).collect();
    let tier = |t: &str| t.to_owned();
    assert_eq!(
        rows,
        [
            (new.clone(), tier("recent")),
            (recent[0].clone(), tier("recent")),
            (recent[1].clone(), tier("recent")),
            (daily_keep, tier("daily")),
            (monthly_keep, tier("monthly")),
        ]
    );
    assert_eq!(list[1]["createdAt"], "2026-11-14T09:00:00.000Z");
    assert!(list[0]["size"].as_u64().unwrap() > 1000);
    for gone in [daily_drop, monthly_drop, ancient] {
        assert!(!folder.join(gone).exists());
    }
    assert!(folder.join("notes.txt").exists() && folder.join("kasboek-export-2026-01-01_000000.kasboek").exists());
    // The status remembers the backup.
    let status = b.call("backup.status", json!({})).unwrap();
    assert_eq!(status["lastBackupAt"], "2026-11-14T10:00:00.000Z");
    assert_eq!(status["lastBackupFile"], made["file"]);
    assert_eq!(status["keep"], 10);
}

/// Europe/Amsterdam in 2026: daylight saving time from 2026-03-29T01:00Z to 2026-10-25T01:00Z.
struct Amsterdam;

impl LocalZone for Amsterdam {
    fn offset_minutes_at(&self, utc_ms: i64) -> i32 {
        if (1_774_746_000_000..1_792_890_000_000).contains(&utc_ms) {
            120
        } else {
            60
        }
    }
}

#[test]
fn file_names_follow_the_local_clock_through_a_daylight_saving_change() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().to_path_buf();
    let b = rig_with(PASSWORD_B, vec![Some(folder.clone()), Some(out.path().join("e.kasboek"))], |o| o.backup_zone = Arc::new(Amsterdam));
    b.call("backup.chooseFolder", json!({})).unwrap();
    let name_of = |made: Value| Path::new(made["file"].as_str().unwrap()).file_name().unwrap().to_str().unwrap().to_owned();
    // 2026-03-29T00:59:59Z is 01:59:59 in Amsterdam, a second later it is 03:00:00.
    b.clock.set(1_774_746_000_000 - 1000);
    assert_eq!(name_of(b.call("backup.runNow", json!({})).unwrap()), "kasboek-backup-2026-03-29_015959.kasboek");
    b.clock.set(1_774_746_000_000);
    assert_eq!(name_of(b.call("backup.runNow", json!({})).unwrap()), "kasboek-backup-2026-03-29_030000.kasboek");
    // Listing reads the names back as local time: both are exactly the instants they were made.
    let list = b.call("backup.list", json!({})).unwrap();
    assert_eq!(list[0]["createdAt"], "2026-03-29T01:00:00.000Z");
    assert_eq!(list[1]["createdAt"], "2026-03-29T00:59:59.000Z");
    // The save dialog proposes a name from the same clock.
    b.call("transfer.export", json!({})).unwrap();
}

#[test]
fn configure_auto_checks_its_input_and_keeps_the_other_settings() {
    let b = rig(PASSWORD_B, vec![]);
    for bad in [
        json!({}),
        json!({ "enabled": "yes" }),
        json!({ "enabled": false, "keep": 0 }),
        json!({ "enabled": false, "keep": 101 }),
        json!({ "enabled": false, "keep": 1.5 }),
        json!({ "enabled": false, "keep": "3" }),
        json!({ "enabled": false, "other": 1 }),
    ] {
        assert_eq!(b.call("backup.configureAuto", bad).unwrap_err().code, "op.invalid_input");
    }
    let status = b.call("backup.configureAuto", json!({ "enabled": false, "keep": 5.0 })).unwrap();
    assert_eq!(status, json!({ "autoEnabled": false, "folder": null, "keep": 5, "lastBackupAt": null, "lastBackupFile": null }));
    assert_eq!(b.call("backup.configureAuto", json!({ "enabled": false })).unwrap()["keep"], 5);
    assert_eq!(b.call("backup.runNow", json!({})).unwrap_err().code, "backup.no_folder");
    assert_eq!(b.call("backup.list", json!({})).unwrap(), json!([]));
    assert_eq!(b.call("backup.revealFolder", json!({})).unwrap(), json!({ "ok": false }));
    assert_eq!(b.call("backup.chooseFolder", json!({})).unwrap(), json!({ "folder": null }));
}

#[test]
fn a_missing_folder_is_skipped_by_the_scheduler_and_refused_by_run_now() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().join("unplugged");
    std::fs::create_dir(&folder).unwrap();
    let b = rig(PASSWORD_B, vec![Some(folder.clone())]);
    b.call("backup.chooseFolder", json!({})).unwrap();
    assert_eq!(b.call("backup.revealFolder", json!({})).unwrap(), json!({ "ok": true }));
    std::fs::remove_dir(&folder).unwrap();
    assert_eq!(b.call("backup.runNow", json!({})).unwrap_err().code, "backup.folder_missing");
    assert_eq!(b.call("backup.list", json!({})).unwrap(), json!([]));
    // Switching on makes no backup of a folder that is not there, and does not create it.
    b.call("backup.configureAuto", json!({ "enabled": true })).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(!folder.exists());
}

fn fast_timing() -> BackupTiming {
    let t = Duration::from_millis(40);
    BackupTiming { start: Duration::from_secs(3600), soon: t, after_change: t, check: Duration::from_secs(3600) }
}

#[test]
fn automatic_backups_follow_changes_tell_the_screens_and_stop_on_lock() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().join("backups");
    std::fs::create_dir(&folder).unwrap();
    let b = rig_with(PASSWORD_B, vec![Some(folder.clone())], |o| o.backup_timing = fast_timing());
    b.call("backup.chooseFolder", json!({})).unwrap();
    // Switching on makes the first backup straight away.
    b.call("backup.configureAuto", json!({ "enabled": true })).unwrap();
    wait_for("the first backup", || b.events().iter().any(|e| matches!(e, AppEvent::BackupCompleted { .. })));
    let first = names_in(&folder);
    assert_eq!(first, ["kasboek-backup-2026-11-14_100000.kasboek"]);
    assert!(b.events().contains(&AppEvent::BackupCompleted { file: folder.join(&first[0]).to_string_lossy().into_owned() }));
    // The timers of the changes made so far (choosing the folder) run out first.
    std::thread::sleep(Duration::from_millis(300));

    // An important change (a delete) later makes another one soon; an ordinary change within the hour does not.
    b.clock.advance(5000);
    b.account("Checking");
    b.call("transactions.delete", json!({ "ids": [999] })).unwrap();
    let second = folder.join("kasboek-backup-2026-11-14_100005.kasboek").to_string_lossy().into_owned();
    wait_for("the backup after a change", || b.events().contains(&AppEvent::BackupCompleted { file: second.clone() }));
    assert_eq!(names_in(&folder).len(), 2);

    // A change right before the lock is saved by the lock itself, and the timer of this login ends there.
    b.clock.advance(5000);
    b.account("Savings");
    call(&b.service, "auth.lock", json!({})).unwrap();
    let after_lock = names_in(&folder);
    assert!(after_lock.len() >= 3, "{after_lock:?}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(names_in(&folder), after_lock);
    assert_eq!(&std::fs::read(folder.join(&after_lock[2])).unwrap()[..8], b"KASBOEK2");
}

#[test]
fn a_backup_that_fails_says_so_without_naming_secrets() {
    let out = tempfile::tempdir().unwrap();
    let folder = out.path().join("backups");
    std::fs::create_dir(&folder).unwrap();
    let b = rig_with(PASSWORD_B, vec![Some(folder.clone())], |o| o.backup_timing = fast_timing());
    b.call("backup.chooseFolder", json!({})).unwrap();
    b.set_settings(json!({ "autoBackupEnabled": true }));
    // The folder turns into a file: it is "there", but nothing can be written in it.
    std::fs::remove_dir(&folder).unwrap();
    std::fs::write(&folder, b"not a folder").unwrap();
    b.account("Checking");
    wait_for("the failure", || b.events().iter().any(|e| matches!(e, AppEvent::BackupFailed { .. })));
    let message =
        b.events().into_iter().find_map(|e| if let AppEvent::BackupFailed { message } = e { Some(message) } else { None }).unwrap();
    assert_eq!(message, "Something went wrong. Details are in the log.");
    assert!(!message.contains(PASSWORD_B) && !message.contains(folder.to_str().unwrap()));
}

#[test]
fn the_import_cancels_the_jobs_that_are_running_but_not_itself() {
    fn wait_for_cancel(ctx: &JobCtx, _: Value) -> Result<Value, AppError> {
        loop {
            ctx.cancel().check()?;
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("a.kasboek");
    let a = rig(PASSWORD_A, vec![Some(file.clone())]);
    a.account("Checking");
    export(&a, &file);
    let b = rig_with(PASSWORD_B, vec![Some(file.clone())], |o| {
        o.service_ops.add("test.waitForCancel", wait_for_cancel);
    });
    let token = b.call("transfer.pick", json!({})).unwrap()["token"].as_str().unwrap().to_owned();
    std::thread::scope(|scope| {
        let waiting = scope.spawn(|| b.call("test.waitForCancel", json!({})));
        std::thread::sleep(Duration::from_millis(100));
        b.call("transfer.import", json!({ "token": token, "password": PASSWORD_A })).unwrap();
        assert_eq!(waiting.join().unwrap().unwrap_err().code, "job.cancelled");
    });
    assert_eq!(b.names(), ["Checking"]);
}

#[test]
fn export_and_import_need_a_login_and_a_cancelled_dialog_does_nothing() {
    let out = tempfile::tempdir().unwrap();
    let b = rig(PASSWORD_B, vec![None, None]);
    assert_eq!(b.call("transfer.export", json!({})).unwrap(), json!({ "file": null }));
    assert!(b.audit().contains(&("transfer.export".to_owned(), "{}".to_owned())));
    assert_eq!(b.call("transfer.pick", json!({})).unwrap(), Value::Null);
    assert_eq!(b.call("transfer.export", json!({ "path": "/x" })).unwrap_err().code, "op.invalid_input");
    for bad in [
        json!({}),
        json!({ "token": "" }),
        json!({ "token": "t", "password": "x".repeat(257) }),
        json!({ "token": "t", "code": "1234567890123" }),
        json!({ "token": "t", "other": 1 }),
    ] {
        assert_eq!(b.call("transfer.import", bad).unwrap_err().code, "op.invalid_input");
    }
    call(&b.service, "auth.lock", json!({})).unwrap();
    for op in ["transfer.export", "backup.status", "backup.runNow", "backup.list"] {
        assert_eq!(b.call(op, json!({})).unwrap_err().code, "auth.locked", "{op}");
    }
    let e = b.call("transfer.pick", json!({})).unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("auth.locked", "Unlock Kasboek first."));
    assert_eq!(b.call("transfer.import", json!({ "token": "t" })).unwrap_err().code, "auth.locked");
    drop(out);
}
