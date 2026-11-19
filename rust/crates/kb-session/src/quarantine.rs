//! "Erase" does not delete: the database, the account file and the safety copies are moved into `erased/<time>/` inside
//! the data folder and Kasboek starts fresh. Everything stays encrypted; the original password or recovery key brings
//! it back. After 30 days the whole entry is removed for good. Port of src/main/quarantine.ts.
use crate::error::{SessionError, SessionResult};
use crate::paths::Paths;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const QUARANTINE_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// An entry is named after the time it was set aside (`/^\d{10,}$/`); only such names are ever resolved.
pub fn is_entry_name(name: &str) -> bool {
    name.len() >= 10 && name.bytes().all(|b| b.is_ascii_digit())
}

fn quarantine_dir(l: &Paths) -> PathBuf {
    l.data_dir.join("erased")
}

/// The files that belong to one copy: their name inside an entry, and where they live.
fn parts(l: &Paths) -> [(&'static str, &Path); 3] {
    [("account.json", &l.account_file), ("kasboek.db", &l.db_file), ("keystore.json", &l.legacy_keystore_file)]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErasedEntry {
    pub name: String,
    pub erased_at: u64,
}

/// Every entry folder under erased/, newest first, whatever it holds.
fn entry_names(l: &Paths) -> Vec<ErasedEntry> {
    let Ok(read) = fs::read_dir(quarantine_dir(l)) else { return Vec::new() };
    let mut entries: Vec<ErasedEntry> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| is_entry_name(n))
        .filter_map(|name| Some(ErasedEntry { erased_at: name.parse().ok()?, name }))
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.erased_at));
    entries
}

/// Data that can be opened again: a database together with its account file (or the old key file).
fn restorable(dir: &Path) -> bool {
    dir.join("kasboek.db").exists() && (dir.join("account.json").exists() || dir.join("keystore.json").exists())
}

/// Quarantined copies that can be restored, newest first. Empty entry folders are removed on the way.
pub fn list_erased(l: &Paths) -> Vec<ErasedEntry> {
    let mut found = Vec::new();
    for e in entry_names(l) {
        let dir = quarantine_dir(l).join(&e.name);
        if restorable(&dir) {
            found.push(e);
        } else {
            // remove_dir only removes an empty folder.
            let _ = fs::remove_dir(&dir);
        }
    }
    found
}

/// Moves the data aside. Returns the entry name, or `None` when there was nothing to move. All or nothing: when a move
/// fails, the ones already done are undone and the error is returned. Whatever can't be moved back is reported to `log`.
/// Two erases in the same millisecond get different entries.
pub fn quarantine_data(l: &Paths, now_ms: i64, log: &mut dyn FnMut(&str)) -> io::Result<Option<String>> {
    // The account goes first: if this stops half-way, Kasboek sees "no account" and keeps the old database aside.
    let mut items: Vec<(PathBuf, &str)> =
        parts(l).into_iter().filter(|(_, live)| live.exists()).map(|(name, live)| (live.to_path_buf(), name)).collect();
    if l.safety_dir.exists() {
        items.push((l.safety_dir.clone(), "safety-backups"));
    }
    if items.is_empty() {
        return Ok(None);
    }
    let mut name = now_ms.max(0).to_string();
    let mut dir = quarantine_dir(l).join(&name);
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> io::Result<()> {
        fs::create_dir_all(quarantine_dir(l))?;
        // Not recursive: an existing entry is never reused, the next free number is taken.
        loop {
            match fs::create_dir(&dir) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    name = (name.parse::<u64>().unwrap_or(0) + 1).to_string();
                    dir = quarantine_dir(l).join(&name);
                }
                Err(e) => return Err(e),
            }
        }
        for (from, item) in &items {
            let to = dir.join(item);
            fs::rename(from, &to)?;
            moved.push((from.clone(), to));
        }
        Ok(())
    })();
    if let Err(err) = result {
        for (from, to) in moved.iter().rev() {
            if let Err(e) = fs::rename(to, from) {
                log(&format!("erase rollback: could not move {} back to {}: {e}", to.display(), from.display()));
            }
        }
        // Only empty folders are removed here: anything that could not be moved back stays in the entry.
        let _ = fs::remove_dir(&dir);
        let _ = fs::remove_dir(quarantine_dir(l));
        return Err(err);
    }
    Ok(Some(name))
}

/// A name that is free in `dir`: the file's own, else prefixed with "restored-" (and a number if needed).
fn free_name(dir: &Path, file: &str) -> String {
    let mut candidate = file.to_owned();
    let mut i = 0;
    while dir.join(&candidate).exists() {
        candidate = format!("restored-{}{file}", if i > 0 { format!("{i}-") } else { String::new() });
        i += 1;
    }
    candidate
}

fn io_failed(e: io::Error) -> SessionError {
    SessionError::new("op.failed", format!("Could not restore the erased data: {e}"))
}

/// Brings one copy back. Only when no account exists here: it would replace it.
pub fn restore_erased(l: &Paths, name: &str, now_ms: i64) -> SessionResult<()> {
    if l.account_file.exists() {
        return Err(SessionError::new(
            "auth.restore_blocked",
            "Kasboek is already set up. Restoring erased data is only possible on the first screen.",
        ));
    }
    // The name decides which folder is read: only a plain timestamp, only directly under erased/.
    let dir = quarantine_dir(l).join(name);
    if !is_entry_name(name) || !dir.exists() {
        return Err(SessionError::new("auth.nothing_erased", "There is no erased data to restore."));
    }
    // Without its database, or without an account or key file for it, there is nothing that can be opened.
    if !restorable(&dir) {
        return Err(SessionError::new("auth.nothing_erased", "This erased copy is incomplete and can’t be restored."));
    }
    // The safety copies first: if this fails, no account is back yet and the copy stays whole enough to try again.
    let safety = dir.join("safety-backups");
    if safety.exists() {
        fs::create_dir_all(&l.safety_dir).map_err(io_failed)?;
        for f in fs::read_dir(&safety).map_err(io_failed)? {
            let f = f.map_err(io_failed)?.file_name();
            let target = free_name(&l.safety_dir, &f.to_string_lossy());
            fs::rename(safety.join(&f), l.safety_dir.join(target)).map_err(io_failed)?;
        }
    }
    // Files that are here without an account can't be opened by anyone: keep them aside. Never overwrite them.
    let aside = |live: &Path| -> io::Result<()> {
        let mut target = live.as_os_str().to_owned();
        target.push(format!(".orphaned-{now_ms}"));
        fs::rename(live, PathBuf::from(target))
    };
    if l.db_file.exists() && dir.join("kasboek.db").exists() {
        aside(&l.db_file).map_err(io_failed)?;
    }
    if l.legacy_keystore_file.exists() && dir.join("keystore.json").exists() {
        aside(&l.legacy_keystore_file).map_err(io_failed)?;
    }
    // The account comes back last: an account without its database would start an empty one.
    for (item, live) in parts(l).into_iter().rev() {
        if dir.join(item).exists() {
            fs::rename(dir.join(item), live).map_err(io_failed)?;
        }
    }
    fs::remove_dir_all(&dir).map_err(io_failed)?;
    Ok(())
}

/// Removes copies older than 30 days, whole: database, account and safety copies. Returns how many.
pub fn purge_erased(l: &Paths, now_ms: i64) -> usize {
    let mut removed = 0;
    for e in entry_names(l) {
        // A folder name beyond i64 (or in the future) is never old enough; no arithmetic on it can overflow.
        let age = i64::try_from(e.erased_at).ok().and_then(|at| now_ms.checked_sub(at));
        if age.is_none_or(|a| a < QUARANTINE_DAYS * DAY_MS) {
            continue;
        }
        if fs::remove_dir_all(quarantine_dir(l).join(&e.name)).is_ok() {
            removed += 1;
        }
    }
    removed
}
