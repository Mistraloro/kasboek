//! `prefs.json` for the service: the `prefs.*` and `app.*` operations (they work before the account is read and while
//! locked) and the app's own cache keys (`lastAuth`, `lastTheme`). One `Core` without a database owns the preferences
//! cache; writing a cache key replaces it, so a later `prefs.update` does not write an old copy back.
use kb_core::{Actor, AppError, Core, CoreConfig, SeededRng, SystemClock};
use kb_db::SqliteStore;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) struct PrefsStore {
    file: PathBuf,
    languages: Vec<String>,
    utc_offset_minutes: i32,
    core: Mutex<Core<SqliteStore>>,
}

fn new_core(file: &Path, languages: &[String], utc_offset_minutes: i32) -> Core<SqliteStore> {
    Core::new(
        None,
        Box::new(SystemClock { utc_offset_minutes }),
        Box::new(SeededRng::new(0)),
        CoreConfig { prefs_file: Some(file.to_path_buf()), system_languages: languages.to_vec() },
    )
}

impl PrefsStore {
    pub(crate) fn new(file: PathBuf, languages: Vec<String>, utc_offset_minutes: i32) -> Self {
        let core = Mutex::new(new_core(&file, &languages, utc_offset_minutes));
        Self { file, languages, utc_offset_minutes, core }
    }

    pub(crate) fn dispatch(&self, op: &str, input: Value) -> Result<Value, AppError> {
        self.core.lock().unwrap_or_else(|e| e.into_inner()).dispatch(op, input, Actor::User)
    }

    /// The `autoLockMinutes` preference (0 = never).
    pub(crate) fn auto_lock_minutes(&self) -> u64 {
        self.dispatch("prefs.get", json!({})).ok().and_then(|p| p["autoLockMinutes"].as_u64()).unwrap_or(10)
    }

    /// The whole file as an object (empty when it is missing or unreadable).
    pub(crate) fn raw(&self) -> Map<String, Value> {
        read_object(&self.file).unwrap_or_default()
    }

    /// Sets or removes (`None`) one key and leaves the others as they are; nothing is written when the key already has
    /// that value. A failed write is not an error: the cache is a convenience.
    pub(crate) fn set_key(&self, key: &str, value: Option<Value>) {
        let mut guard = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if update_prefs_key(&self.file, key, value) {
            *guard = new_core(&self.file, &self.languages, self.utc_offset_minutes);
        }
    }
}

/// The keys of `prefs.json`. `None` when the file is missing, or when it can't be read as a JSON object.
fn read_object(file: &Path) -> Option<Map<String, Value>> {
    match std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// Sets or removes (`None`) one key of `prefs.json` and leaves the others alone; `true` when the file was written.
/// A file that exists but can't be read as a JSON object is moved to `prefs.json.bad` first (and nothing is written when
/// that fails), so a damaged file is never overwritten blindly. The temporary file is new and private (0600 on Unix).
/// Never fails the caller.
pub fn update_prefs_key(file: &Path, key: &str, value: Option<Value>) -> bool {
    let mut map = match read_object(file) {
        Some(m) => m,
        None if file.exists() => {
            if std::fs::rename(file, file.with_extension("json.bad")).is_err() {
                return false;
            }
            Map::new()
        }
        None => Map::new(),
    };
    if map.get(key) == value.as_ref() {
        return false;
    }
    match value {
        Some(v) => map.insert(key.to_owned(), v),
        None => map.remove(key),
    };
    if let Some(dir) = file.parent() {
        let _ = crate::paths::create_private_dir(dir);
    }
    let tmp = file.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let text = serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default();
    let written = {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&tmp).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()))
    };
    if written.is_ok() && std::fs::rename(&tmp, file).is_ok() {
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        std::fs::write(&file, "{ not json").unwrap();
        let store = PrefsStore::new(file.clone(), vec![], 0);
        store.set_key("lastTheme", Some(json!("dark")));
        assert_eq!(std::fs::read_to_string(dir.path().join("prefs.json.bad")).unwrap(), "{ not json");
        assert_eq!(store.raw()["lastTheme"], "dark");
    }

    #[test]
    fn a_file_that_cannot_be_moved_aside_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        std::fs::write(&file, "[1]").unwrap();
        // A directory in the way of the .bad name makes the move fail.
        std::fs::create_dir(dir.path().join("prefs.json.bad")).unwrap();
        std::fs::write(dir.path().join("prefs.json.bad").join("x"), "x").unwrap();
        assert!(!update_prefs_key(&file, "a", Some(json!(1))));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[1]");
    }

    #[test]
    fn an_unchanged_key_is_not_written_and_other_keys_stay() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        std::fs::write(&file, r#"{"language":"nl","lastAuth":{"mode":"password"}}"#).unwrap();
        assert!(!update_prefs_key(&file, "lastAuth", Some(json!({ "mode": "password" }))));
        assert!(update_prefs_key(&file, "lastTheme", Some(json!("dark"))));
        let map = read_object(&file).unwrap();
        assert_eq!((map["language"].clone(), map["lastTheme"].clone()), (json!("nl"), json!("dark")));
        assert!(update_prefs_key(&file, "lastTheme", None));
        assert!(!read_object(&file).unwrap().contains_key("lastTheme"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        assert!(update_prefs_key(&file, "a", Some(json!(1))));
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
