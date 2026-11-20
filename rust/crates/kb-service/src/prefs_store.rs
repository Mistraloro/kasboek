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

    /// `lastAuth` as the session wants it as a hint.
    pub(crate) fn raw(&self) -> Map<String, Value> {
        match std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    /// Sets or removes (`None`) one key and leaves the others as they are. A failed write is not an error: the cache
    /// is a convenience.
    pub(crate) fn set_key(&self, key: &str, value: Option<Value>) {
        let mut guard = self.core.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.raw();
        match value {
            Some(v) => map.insert(key.to_owned(), v),
            None => map.remove(key),
        };
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
        *guard = new_core(&self.file, &self.languages, self.utc_offset_minutes);
    }
}
