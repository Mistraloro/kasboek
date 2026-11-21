//! Service operations: transfer.export, transfer.pick and transfer.import (src/main/transfer/service.ts), and the file code
//! the backups share: writing an export, reading one for Import.
//!
//! An export holds the key material of the whole database (the master key and the vault, sealed with a key derived from the
//! master key) and the password and recovery slots, so every secret here is a `Zeroizing` value, the file is written readable
//! by its owner only, and no error or audit entry carries a secret. The page never sends a path: it gets a token for a file the
//! person picked (or for a backup of the backup folder) and sends that back.
use crate::jobs::{Cancel, JobCtx, ServiceTable};
use crate::AppError;
use kb_core::backup_tiers::{stamp, LocalZone};
use kb_core::settings;
use kb_crypto::aead::Sealed;
use kb_crypto::encoding::base64_encode;
use kb_crypto::slot::{make_slot_with, SlotKind};
use kb_crypto::transfer::{
    encode_transfer, open_transfer, read_transfer_header, AuthMode as FileMode, Credential, TransferError, TransferInput, TransferKind,
    TRANSFER_EXTENSION,
};
use kb_db::{DbKey, OpenOptions, Queries, SqliteStore, Store, SCHEMA_VERSION};
use kb_session::account::{AccountData, Attempts, AuthMode, Slots};
use kb_session::password::check_password;
use kb_session::time::iso;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use zeroize::Zeroizing;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const FILTER: [(&str, &[&str]); 1] = [("Kasboek export", &[TRANSFER_EXTENSION])];
const WEAK_PASSWORD: &str = "This password doesn’t meet the requirements: at least 12 characters, three kinds of characters, and not a common or predictable password.";

pub(super) fn register(table: &mut ServiceTable) {
    table.add("transfer.export", export).add("transfer.pick", pick).add("transfer.import", import);
}

/// The files the person picked, by token. The page never learns a path and can only name a file it was shown.
static PICKED: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(Mutex::default);

/// The error with the text of the TypeScript app (curly apostrophes, where kb-crypto writes straight ones).
pub(super) fn error_of(e: &TransferError) -> AppError {
    AppError::new(e.code(), e.to_string().replace('\'', "’"))
}

fn session_error(e: kb_session::SessionError) -> AppError {
    AppError::new(&e.code, e.message)
}

/// The `kasboek-export-<stamp>.kasboek` of the save dialog.
pub(crate) fn export_file_name(now_ms: i64, zone: &dyn LocalZone) -> String {
    format!("kasboek-export-{}.{TRANSFER_EXTENSION}", stamp(now_ms, zone))
}

pub(crate) fn json_string(p: &Path) -> Value {
    Value::String(p.to_string_lossy().into_owned())
}

/// `audit_log` row of a mutating operation. Never has details: they could hold secrets (`redact` in src/core/ops.ts).
pub(super) fn audit(ctx: &JobCtx, op: &'static str) -> Result<(), AppError> {
    ctx.with_core(move |w| Ok::<_, AppError>(w.core().db()?.audit_insert("user", op, "{}")?))?
}

/// Refuses on the lock screen: only at first setup, or once logged in, may the data be replaced.
fn refuse_when_locked(ctx: &JobCtx) -> Result<(), AppError> {
    if ctx.with_core(|w| w.session().status().state)? == "locked" {
        return Err(AppError::new("auth.locked", "Unlock Kasboek first."));
    }
    Ok(())
}

/* ---------- Writing ---------- */

/// Opens a file for writing, new, readable by its owner only on Unix.
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// Writes `bytes` to `<file>.partial` and renames it over `file`, so a file is whole or not there. A `.partial` that is in the
/// way is removed first (`create_new` does not follow a link that someone left there).
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut name = file.as_os_str().to_owned();
    name.push(".partial");
    let partial = PathBuf::from(name);
    let _ = fs::remove_file(&partial);
    let written = create_private(&partial).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&partial, file)
    });
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written.map_err(|_| AppError::failed())
}

/// What `encode_current` made: the file, and the key of the database it came from (so a late settings update does not land
/// in a database that was replaced meanwhile).
pub(crate) struct Encoded {
    pub bytes: Vec<u8>,
    pub db_key: Zeroizing<String>,
}

/// Reads and encrypts the live data in one step on the database worker: locking wipes the master key, which must not happen
/// halfway (a file sealed with a zeroed key could never be opened). Only writing the finished bytes waits.
pub(crate) fn encode_current(worker: &mut crate::Worker, kind: TransferKind) -> Result<Encoded, AppError> {
    let now = worker.now_ms();
    let session = worker.session();
    let tmp = session.paths().data_dir.join(format!("snapshot-{}.tmp", uuid()));
    let (account, master, vault) = session.secrets().map_err(session_error)?;
    let db = session.db().map_err(session_error)?;
    let snapshot = db.snapshot_encrypted(&tmp).and_then(|()| Ok((fs::read(&tmp), db.schema_version()?)));
    let _ = fs::remove_file(&tmp);
    let (db_file, schema_version) = match snapshot {
        Ok((Ok(file), version)) => (file, version),
        Ok((Err(_), _)) => return Err(AppError::failed()),
        Err(e) => return Err(e.into()),
    };
    let mode = match account.mode {
        AuthMode::Password => FileMode::Password,
        AuthMode::Device => FileMode::Device,
    };
    let bytes = encode_transfer(&TransferInput {
        kind,
        created_at: iso(now),
        app_version: APP_VERSION.to_owned(),
        schema_version,
        mode,
        two_factor: account.two_factor,
        password_slot: account.slots.password.clone(),
        recovery_slot: account.slots.recovery.clone(),
        master,
        vault,
        db_file: &db_file,
    })
    .map_err(|e| error_of(&e))?;
    Ok(Encoded { bytes, db_key: vault.db_key.clone() })
}

/// Writes an export or backup of the live data to `file` (`writeTransfer`). A backup is also noted in the settings.
pub(crate) fn write_transfer(ctx: &JobCtx, file: &Path, kind: TransferKind) -> Result<(), AppError> {
    let Encoded { bytes, db_key } = ctx.with_core(move |w| encode_current(w, kind))??;
    write_atomic(file, &bytes)?;
    if kind == TransferKind::Backup {
        let path = json_string(file);
        // Locked, or replaced, while writing: the file is complete, but the database it came from is closed.
        ctx.with_core(move |w| {
            let now = w.now_ms();
            let same = w.session().secrets().is_ok_and(|(_, _, v)| *v.db_key == *db_key);
            if !same {
                return Ok(());
            }
            let mut patch = Map::new();
            patch.insert("lastBackupAt".into(), Value::String(iso(now)));
            patch.insert("lastBackupFile".into(), path);
            settings::update_settings(w.core().db()?, &patch).map(|_| ())
        })??;
    }
    Ok(())
}

/// A random version 4 UUID, the way `randomUUID` writes it (names of temporary files and tokens).
fn uuid() -> String {
    let mut b = kb_crypto::random_bytes::<16>();
    b[6] = b[6] & 0x0f | 0x40;
    b[8] = b[8] & 0x3f | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/* ---------- Operations ---------- */

fn export(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    // The data must be readable: refuse before showing a dialog.
    ctx.with_core(|w| w.session().secrets().map(|_| ()).map_err(session_error))??;
    let default_name = export_file_name(ctx.with_core(|w| w.now_ms())?, ctx.backups().zone());
    let Some(file) = ctx.desktop().save_file("Export Kasboek", &default_name, &FILTER) else {
        audit(ctx, "transfer.export")?;
        return Ok(json!({ "file": null }));
    };
    write_transfer(ctx, &file, TransferKind::Export)?;
    audit(ctx, "transfer.export")?;
    Ok(json!({ "file": json_string(&file) }))
}

fn pick(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    refuse_when_locked(ctx)?;
    match ctx.desktop().open_file("Import a Kasboek export", &FILTER) {
        Some(file) => describe(ctx, &file),
        None => Ok(Value::Null),
    }
}

/// `z.object({}).strict()`.
fn no_input(input: Value) -> Result<(), AppError> {
    match input {
        Value::Null => Ok(()),
        Value::Object(map) if map.is_empty() => Ok(()),
        Value::Object(_) => Err(AppError::invalid_input("Unrecognized key")),
        _ => Err(AppError::invalid_input("Invalid input: expected object")),
    }
}

/// Reads the header of a file for Import and hands back a token for it (`describeTransfer`).
pub(crate) fn describe(ctx: &JobCtx, file: &Path) -> Result<Value, AppError> {
    let bytes = fs::read(file).map_err(|_| AppError::failed())?;
    let header = read_transfer_header(&bytes).map_err(|e| error_of(&e))?;
    let token = uuid();
    PICKED.lock().unwrap_or_else(|e| e.into_inner()).insert(token.clone(), file.to_owned());
    let needs_new_password = header.mode == FileMode::Device && !ctx.with_core(|w| w.session().can_use_device_mode())?;
    let file_name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(json!({
        "token": token,
        "fileName": file_name,
        "kind": header.kind,
        "createdAt": header.created_at,
        "appVersion": header.app_version,
        "mode": header.mode,
        "twoFactor": header.two_factor,
        "hasPassword": header.slots.password.is_some(),
        "needsNewPassword": needs_new_password,
    }))
}

/* ---------- Import ---------- */

/// The input of `transfer.import`, strict like its zod schema; the secrets are taken out of the JSON without a copy.
struct ImportInput {
    token: String,
    password: Option<Zeroizing<String>>,
    code: Option<Zeroizing<String>>,
    recovery_key: Option<Zeroizing<String>>,
    new_password: Option<Zeroizing<String>>,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

impl ImportInput {
    fn parse(input: Value) -> Result<Self, AppError> {
        let Value::Object(mut map) = input else { return Err(AppError::invalid_input("Invalid input: expected object")) };
        if let Some(key) = map.keys().find(|k| !["token", "password", "code", "recoveryKey", "newPassword"].contains(&k.as_str())) {
            return Err(AppError::invalid_input(format!("Unrecognized key: {key}")));
        }
        let mut text = |key: &str, max: usize| -> Result<Option<Zeroizing<String>>, AppError> {
            match map.remove(key) {
                None => Ok(None),
                Some(Value::String(s)) => {
                    let s = Zeroizing::new(s);
                    if utf16_len(&s) > max {
                        return Err(AppError::invalid_input(format!("Invalid {key}.")));
                    }
                    Ok(Some(s))
                }
                Some(_) => Err(AppError::invalid_input(format!("Invalid {key}."))),
            }
        };
        let token = text("token", usize::MAX)?.filter(|t| !t.is_empty()).ok_or_else(|| AppError::invalid_input("Invalid token."))?;
        let password = text("password", 256)?;
        let code = text("code", 12)?;
        let recovery_key = text("recoveryKey", 80)?;
        let new_password = text("newPassword", 256)?;
        if new_password.as_ref().is_some_and(|p| !check_password(p).ok) {
            return Err(AppError::invalid_input(WEAK_PASSWORD));
        }
        Ok(Self { token: token.to_string(), password, code, recovery_key, new_password })
    }
}

/// JavaScript truthiness of a stored setting.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Removes the staged copy unless it was moved into place.
struct Staged(PathBuf);

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn import(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    let input = ImportInput::parse(input)?;
    refuse_when_locked(ctx)?;
    let file = PICKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&input.token)
        .cloned()
        .ok_or_else(|| AppError::new("transfer.expired", "Choose the file again."))?;
    let bytes = fs::read(&file).map_err(|_| AppError::failed())?;
    let now_ms = ctx.with_core(|w| w.now_ms())?;
    let credential = match (&input.recovery_key, &input.password) {
        (Some(key), _) if !key.is_empty() => Credential::RecoveryKey(key),
        (_, password) => Credential::Password {
            password: password.as_deref().map_or("", |p| p.as_str()),
            code: input.code.as_deref().map(String::as_str),
        },
    };
    // The slow part (Argon2id) runs here, on the job thread, and not on the database worker.
    let contents = open_transfer(&bytes, &credential, now_ms as f64 / 1000.0).map_err(|e| error_of(&e))?;
    drop(bytes);
    ctx.cancel().check()?;
    if contents.header.schema_version > SCHEMA_VERSION {
        return Err(AppError::new("transfer.too_new", "This file was made by a newer version of Kasboek. Update the app first."));
    }

    // Check the database inside before touching anything. The file may come from anywhere: its AI address, permissions, backup
    // folder, assistant memory and API keys are dropped here, on the staged copy, so a failure leaves everything as it was.
    let (data_dir, unlocked, assistant_on, can_device, cost) = ctx.with_core(|w| {
        let unlocked = w.session().is_unlocked();
        let assistant_on = match (unlocked, w.core().db()) {
            (true, Ok(db)) => settings::get_settings(db).ok().and_then(|s| s.get("assistantEnabled").map(truthy)),
            _ => None,
        };
        let s = w.session();
        (s.paths().data_dir.clone(), unlocked, assistant_on, s.can_use_device_mode(), s.argon_cost())
    })?;
    let staged = Staged(data_dir.join(format!("import-{}.db", uuid())));
    create_private(&staged.0)
        .and_then(|mut f| f.write_all(&contents.db_file).and_then(|()| f.sync_all()))
        .map_err(|_| AppError::failed())?;
    let assistant_off = unlocked && assistant_on != Some(true);
    let reset = {
        let key = DbKey::from_hex(&contents.vault.db_key)?;
        let check = SqliteStore::open(&staged.0, &key, OpenOptions { migrate: false })?;
        if !check.integrity_ok()? {
            return Err(AppError::new("transfer.corrupt", "The data inside this file is damaged."));
        }
        // Joining a sync folder keeps the sync key (B6 passes it; an import never does).
        settings::reset_imported_settings(&check, false, assistant_off)?
    };

    // Build the account for this computer. The device seal is added when it is saved.
    let header = &contents.header;
    let mut slots = Slots { recovery: header.slots.recovery.clone(), password: header.slots.password.clone(), device: None };
    let mut mode = match header.mode {
        FileMode::Password => AuthMode::Password,
        FileMode::Device => AuthMode::Device,
    };
    if mode == AuthMode::Device {
        if can_device {
            slots.device = Some(Zeroizing::new(base64_encode(&*contents.master)));
        } else {
            let Some(new_password) = &input.new_password else {
                return Err(AppError::new(
                    "transfer.needs_new_password",
                    "Windows Hello and Touch ID aren’t available here. Choose a password for this computer.",
                ));
            };
            slots.password = Some(
                make_slot_with(&contents.master, new_password, SlotKind::Password, cost)
                    .map_err(|e| AppError::new(e.code(), e.to_string()))?,
            );
            mode = AuthMode::Password;
        }
    }
    let next = AccountData {
        version: 2,
        mode,
        created_at: iso(now_ms),
        two_factor: header.two_factor,
        slots,
        vault: Sealed { iv: String::new(), ct: String::new() },
        attempts: Attempts { failed: 0, last_failed_at: None },
        remember2fa: None,
        extra: Map::new(),
    };

    // Replacing data on this computer: keep a safety copy of what is here first.
    if unlocked {
        let dir = ctx.with_core(|w| w.session().paths().safety_dir.clone())?;
        crate::paths::create_private_dir(&dir).map_err(|_| AppError::failed())?;
        let name = format!("before-import-{}.{TRANSFER_EXTENSION}", stamp(now_ms, ctx.backups().zone()));
        write_transfer(ctx, &dir.join(name), TransferKind::Backup)?;
    }
    ctx.cancel().check()?;

    let own: Cancel = ctx.cancel().clone();
    let used_recovery = contents.used_recovery;
    let (master, vault) = (contents.master, contents.vault);
    let from = staged.0.clone();
    ctx.with_core(move |w| {
        w.replace_database(&own, |session| session.replace_with_import(&from, next, master, vault, used_recovery))?.map_err(session_error)
    })??;
    PICKED.lock().unwrap_or_else(|e| e.into_inner()).remove(&input.token);
    audit(ctx, "transfer.import")?;
    let status = ctx.with_core(|w| serde_json::to_value(w.session().status()))?.map_err(|_| AppError::failed())?;
    Ok(json!({ "status": status, "reset": reset }))
}
