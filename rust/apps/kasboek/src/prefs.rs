//! `prefs.json` as far as the first frame needs it: theme, language and the cached `lastAuth` (plan, section 5). Other keys
//! are not touched here: this file only reads. The service writes prefs.json (`kb_service::update_prefs_key`).
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct LastAuth {
    /// "password" | "device".
    pub mode: String,
    /// "windows-hello" | "touch-id" | None.
    pub device: Option<String>,
    pub two_factor: bool,
    pub remembered_until: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Prefs {
    /// "light" | "dark" | "system".
    pub theme: String,
    /// The theme "system" resolved to when last seen, so that the first frame has the right colours.
    pub last_theme: Option<String>,
    pub language: String,
    pub last_auth: Option<LastAuth>,
    pub formats: Value,
}

impl LastAuth {
    pub fn from_json(v: &Value) -> Option<Self> {
        let mode = v["mode"].as_str().filter(|m| matches!(*m, "password" | "device"))?;
        Some(Self {
            mode: mode.to_string(),
            device: v["device"].as_str().map(str::to_string),
            two_factor: v["twoFactor"].as_bool().unwrap_or(false),
            remembered_until: v["rememberedUntil"].as_str().map(str::to_string),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "mode": self.mode, "device": self.device, "twoFactor": self.two_factor, "rememberedUntil": self.remembered_until })
    }

    /// From an `auth.status` answer.
    pub fn from_status(status: &Value) -> Option<Self> {
        Self::from_json(
            &json!({ "mode": status["mode"], "device": status["device"], "twoFactor": status["twoFactor"], "rememberedUntil": status["rememberedUntil"] }),
        )
    }
}

pub fn read_object(path: &Path) -> Map<String, Value> {
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

impl Prefs {
    pub fn read(path: &Path) -> Self {
        let m = read_object(path);
        Self {
            theme: m.get("theme").and_then(Value::as_str).unwrap_or("system").to_string(),
            last_theme: m.get("lastTheme").and_then(Value::as_str).map(str::to_string),
            language: m.get("language").and_then(Value::as_str).unwrap_or("en").to_string(),
            last_auth: m.get("lastAuth").and_then(LastAuth::from_json),
            formats: m.get("formats").cloned().unwrap_or(Value::Null),
        }
    }

    /// Dark or light for the first frame (`system` uses the last resolved value).
    pub fn first_frame_dark(&self) -> bool {
        match self.theme.as_str() {
            "dark" => true,
            "light" => false,
            _ => self.last_theme.as_deref() == Some("dark"),
        }
    }
}

/// The folder of the fixtures' own files: `--data-dir`, else a folder of its own (never the data of the Electron app).
/// An error when the system does not say where the user's config folder is (no fall back to the temporary folder).
pub fn dev_data_dir(arg: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = arg {
        return Ok(d.into());
    }
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .ok_or_else(|| "Kasboek could not find a config folder for its development files. Give --data-dir.".to_owned())?;
    Ok(base.join("kasboek-native-dev"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_auth_round_trip_keeps_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        std::fs::write(&file, r#"{"theme":"dark","language":"nl","other":{"a":1}}"#).unwrap();
        let auth = LastAuth { mode: "device".into(), device: Some("touch-id".into()), two_factor: true, remembered_until: None };
        kb_service::update_prefs_key(&file, "lastAuth", Some(auth.to_json()));
        let prefs = Prefs::read(&file);
        assert_eq!(prefs.last_auth, Some(auth));
        assert_eq!(prefs.language, "nl");
        assert!(prefs.first_frame_dark());
        assert_eq!(read_object(&file)["other"]["a"], 1);
    }

    #[test]
    fn missing_file_gives_defaults() {
        let prefs = Prefs::read(Path::new("/nonexistent/prefs.json"));
        assert_eq!(prefs.theme, "system");
        assert!(prefs.last_auth.is_none());
        assert!(!prefs.first_frame_dark());
    }
}
