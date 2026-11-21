//! Service operations: backup.* (src/main/transfer/service.ts, ipc.ts), and the automatic backup the scheduler runs. The
//! backups are exports of kind `backup` in a folder the person chose, named `kasboek-backup-<local time>.kasboek`; old ones
//! are thinned out by tier (`kb_core::backup_tiers`). Only files with such a name are ever listed, read or deleted.
use super::transfer::{describe, encode_current, json_string, write_atomic, write_transfer};
use crate::jobs::{JobCtx, ServiceTable};
use crate::{AppError, Worker};
use kb_core::backup_tiers::{is_auto_backup_name, plan_retention, stamp, time_from_name, BackupEntry, LocalZone};
use kb_core::settings;
use kb_crypto::transfer::{TransferKind, TRANSFER_EXTENSION};
use kb_session::time::iso;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub(super) fn register(table: &mut ServiceTable) {
    table
        .add("backup.status", status)
        .add("backup.chooseFolder", choose_folder)
        .add("backup.configureAuto", configure_auto)
        .add("backup.runNow", run_now)
        .add("backup.list", list)
        .add("backup.pick", pick_op)
        .add("backup.revealFolder", reveal_folder);
}

/// The time zone of this computer. File names carry its local time, which changes offset with daylight saving time, so
/// the offset is asked of the operating system for every instant.
pub struct OsZone;

impl LocalZone for OsZone {
    fn offset_minutes_at(&self, utc_ms: i64) -> i32 {
        use chrono::TimeZone;
        chrono::Local.timestamp_millis_opt(utc_ms).single().map_or(0, |t| t.offset().local_minus_utc() / 60)
    }
}

/// A backup file as the folder shows it.
struct Found {
    name: String,
    /// From the name, else the file's modification time (ms since the epoch).
    time: i64,
    size: u64,
}

fn read_settings(ctx: &JobCtx) -> Result<Map<String, Value>, AppError> {
    ctx.with_core(|w| settings::get_settings(w.core().db()?))?
}

/// `BackupStatus`.
fn status_of(s: &Map<String, Value>) -> Value {
    json!({
        "autoEnabled": s["autoBackupEnabled"],
        "folder": s["autoBackupFolder"],
        "keep": s["autoBackupKeep"],
        "lastBackupAt": s["lastBackupAt"],
        "lastBackupFile": s["lastBackupFile"],
    })
}

/// The folder setting when there is one (`s.autoBackupFolder` is truthy).
fn folder_of(s: &Map<String, Value>) -> Option<PathBuf> {
    s.get("autoBackupFolder").and_then(Value::as_str).filter(|f| !f.is_empty()).map(PathBuf::from)
}

fn enabled(s: &Map<String, Value>) -> bool {
    s.get("autoBackupEnabled").and_then(Value::as_bool).unwrap_or(false)
}

fn backup_file_name(now_ms: i64, zone: &dyn LocalZone) -> String {
    format!("kasboek-backup-{}.{TRANSFER_EXTENSION}", stamp(now_ms, zone))
}

fn no_input(input: Value) -> Result<(), AppError> {
    match input {
        Value::Null => Ok(()),
        Value::Object(map) if map.is_empty() => Ok(()),
        Value::Object(_) => Err(AppError::invalid_input("Unrecognized key")),
        _ => Err(AppError::invalid_input("Invalid input: expected object")),
    }
}

/* ---------- The folder ---------- */

/// The backups in `folder`, newest first. The names are read in alphabetical order first (the order Node lists a folder in),
/// so backups of one second keep a fixed order.
fn list_backups(folder: &Path, zone: &dyn LocalZone) -> Result<Vec<Found>, AppError> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .map_err(|_| AppError::failed())?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| is_auto_backup_name(n))
        .collect();
    names.sort();
    let mut found = Vec::with_capacity(names.len());
    for name in names {
        let meta = std::fs::metadata(folder.join(&name)).map_err(|_| AppError::failed())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        found.push(Found { time: time_from_name(&name, zone).unwrap_or(modified), size: meta.len(), name });
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.time));
    Ok(found)
}

/// Thins out the backups by tier. Only touches files Kasboek named.
fn prune(folder: &Path, zone: &dyn LocalZone, now_ms: i64) -> Result<(), AppError> {
    let entries: Vec<BackupEntry> = list_backups(folder, zone)?.into_iter().map(|f| BackupEntry { name: f.name, time: f.time }).collect();
    for name in plan_retention(&entries, now_ms).remove {
        let _ = std::fs::remove_file(folder.join(name));
    }
    Ok(())
}

/// The folder if automatic backups are on and it is reachable (an unplugged drive is skipped, never created).
fn auto_folder(s: &Map<String, Value>) -> Option<PathBuf> {
    folder_of(s).filter(|f| enabled(s) && f.exists())
}

/* ---------- Running ---------- */

/// `runAutoBackup`: one backup now, then thin out the folder.
pub(crate) fn run_auto_backup(ctx: &JobCtx, zone: &dyn LocalZone) -> Result<String, AppError> {
    let s = read_settings(ctx)?;
    let folder = folder_of(&s).ok_or_else(|| AppError::new("backup.no_folder", "Choose a backup folder first."))?;
    if !folder.exists() {
        return Err(AppError::new("backup.folder_missing", "The backup folder can’t be found. Is the drive connected?"));
    }
    let now = ctx.with_core(|w| w.now_ms())?;
    let file = folder.join(backup_file_name(now, zone));
    write_transfer(ctx, &file, TransferKind::Backup)?;
    prune(&folder, zone, ctx.with_core(|w| w.now_ms())?)?;
    Ok(file.to_string_lossy().into_owned())
}

/// `runAutoBackupIfDue`: a backup unless automatic backups are off, the folder is not there, or the newest backup is younger
/// than `max_age_hours`. `None` when nothing was done.
pub(crate) fn run_auto_backup_if_due(ctx: &JobCtx, zone: &dyn LocalZone, max_age_hours: u64) -> Result<Option<String>, AppError> {
    let Some(folder) = auto_folder(&read_settings(ctx)?) else { return Ok(None) };
    let now = ctx.with_core(|w| w.now_ms())?;
    if let Some(newest) = list_backups(&folder, zone)?.first() {
        if now - newest.time < i64::try_from(max_age_hours).unwrap_or(i64::MAX).saturating_mul(3_600_000) {
            return Ok(None);
        }
    }
    run_auto_backup(ctx, zone).map(Some)
}

/// `runAutoBackupSync`: the backup right before the database closes (lock, quit), on the database worker. `None` when
/// automatic backups are off or the folder is not there. The thinning out is best effort, as the TypeScript's.
pub(crate) fn run_auto_backup_sync(w: &mut Worker, zone: &dyn LocalZone) -> Result<Option<String>, AppError> {
    let s = settings::get_settings(w.core().db()?)?;
    let Some(folder) = auto_folder(&s) else { return Ok(None) };
    let now = w.now_ms();
    let file = folder.join(backup_file_name(now, zone));
    let encoded = encode_current(w, TransferKind::Backup)?;
    write_atomic(&file, &encoded.bytes)?;
    let mut patch = Map::new();
    patch.insert("lastBackupAt".into(), Value::String(iso(now)));
    patch.insert("lastBackupFile".into(), json_string(&file));
    settings::update_settings(w.core().db()?, &patch)?;
    let _ = prune(&folder, zone, now);
    Ok(Some(file.to_string_lossy().into_owned()))
}

/* ---------- Operations ---------- */

fn status(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    Ok(status_of(&read_settings(ctx)?))
}

fn choose_folder(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    let folder = ctx.desktop().pick_folder("Choose a backup folder");
    if let Some(folder) = &folder {
        let mut patch = Map::new();
        patch.insert("autoBackupFolder".into(), json_string(folder));
        ctx.with_core(move |w| settings::update_settings(w.core().db()?, &patch).map(|_| ()))??;
    }
    super::transfer::audit(ctx, "backup.chooseFolder")?;
    Ok(json!({ "folder": folder.as_deref().map(json_string) }))
}

fn configure_auto(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    let Value::Object(map) = input else { return Err(AppError::invalid_input("Invalid input: expected object")) };
    if let Some(key) = map.keys().find(|k| *k != "enabled" && *k != "keep") {
        return Err(AppError::invalid_input(format!("Unrecognized key: {key}")));
    }
    let Some(Value::Bool(on)) = map.get("enabled") else { return Err(AppError::invalid_input("Invalid enabled.")) };
    // `z.number().int().min(1).max(100)`: 5.0 is an integer to JavaScript too.
    let keep = match map.get("keep") {
        None => None,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && (1.0..=100.0).contains(&f) => Some(f as u64),
            _ => return Err(AppError::invalid_input("Invalid keep.")),
        },
        Some(_) => return Err(AppError::invalid_input("Invalid keep.")),
    };
    let mut patch = Map::new();
    patch.insert("autoBackupEnabled".into(), Value::Bool(*on));
    if let Some(keep) = keep {
        patch.insert("autoBackupKeep".into(), json!(keep));
    }
    let s = ctx.with_core(move |w| settings::update_settings(w.core().db()?, &patch))??;
    super::transfer::audit(ctx, "backup.configureAuto")?;
    // Make the first automatic backup straight away instead of waiting for the next check.
    if *on {
        ctx.backups().run_if_due_now();
    }
    Ok(status_of(&s))
}

fn run_now(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    Ok(json!({ "file": run_auto_backup(ctx, ctx.backups().zone())? }))
}

fn list(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    let s = read_settings(ctx)?;
    let Some(folder) = folder_of(&s).filter(|f| f.exists()) else { return Ok(json!([])) };
    let found = list_backups(&folder, ctx.backups().zone())?;
    let entries: Vec<BackupEntry> = found.iter().map(|f| BackupEntry { name: f.name.clone(), time: f.time }).collect();
    let plan = plan_retention(&entries, ctx.with_core(|w| w.now_ms())?);
    Ok(Value::Array(
        found
            .iter()
            .map(|b| {
                let tier = plan.tier_of(&b.name).map_or("recent", |t| t.as_str());
                json!({ "name": b.name, "createdAt": iso(b.time), "size": b.size, "tier": tier })
            })
            .collect(),
    ))
}

/// Prepares one backup from the folder for Import (the page never sends a path).
pub(crate) fn pick(ctx: &JobCtx, name: &str) -> Result<Value, AppError> {
    let not_found = || AppError::new("backup.not_found", "That backup can’t be found.");
    let folder = folder_of(&read_settings(ctx)?);
    let folder = folder.filter(|_| is_auto_backup_name(name)).ok_or_else(not_found)?;
    let file = folder.join(name);
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(not_found());
    }
    describe(ctx, &file)
}

fn pick_op(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    let Value::Object(map) = input else { return Err(AppError::invalid_input("Invalid input: expected object")) };
    if let Some(key) = map.keys().find(|k| *k != "name") {
        return Err(AppError::invalid_input(format!("Unrecognized key: {key}")));
    }
    let Some(Value::String(name)) = map.get("name") else { return Err(AppError::invalid_input("Invalid name.")) };
    if name.is_empty() || name.encode_utf16().count() > 200 {
        return Err(AppError::invalid_input("Invalid name."));
    }
    pick(ctx, name)
}

fn reveal_folder(ctx: &JobCtx, input: Value) -> Result<Value, AppError> {
    no_input(input)?;
    let folder = folder_of(&read_settings(ctx)?);
    Ok(json!({ "ok": folder.is_some_and(|f| ctx.desktop().open_path(&f)) }))
}
