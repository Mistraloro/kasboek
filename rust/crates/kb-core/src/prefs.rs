//! Interface preferences in `prefs.json`, readable before login: src/main/prefs.ts and the formats of src/shared/format.ts.
//! Unknown keys in the file are kept when it is written. The file is read once; later changes outside the process are not
//! seen (the TypeScript module caches it the same way).
use crate::error::{AppError, AppResult};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const LANGUAGES: [&str; 8] = ["en", "nl", "fr", "de", "es", "es-419", "pt-PT", "pt-BR"];

/// `pickLanguage` (src/shared/languages.ts): the best interface language for the system's preferred languages.
pub fn pick_language(preferred: &[String]) -> &'static str {
    for raw in preferred {
        let tag = raw.replacen('_', "-", 1);
        if let Some(exact) = LANGUAGES.iter().find(|c| c.eq_ignore_ascii_case(&tag)) {
            return exact;
        }
        let mut parts = tag.split('-');
        let base = parts.next().unwrap_or("");
        let region = parts.next();
        match base {
            "es" => return if region.is_some_and(|r| !r.is_empty() && !r.eq_ignore_ascii_case("ES")) { "es-419" } else { "es" },
            "pt" => return if region.is_some_and(|r| r.eq_ignore_ascii_case("BR")) { "pt-BR" } else { "pt-PT" },
            _ => {}
        }
        if let Some(found) = LANGUAGES.iter().find(|c| **c == base) {
            return found;
        }
    }
    "en"
}

const DECIMAL: [&str; 2] = [",", "."];
const GROUP: [&str; 5] = [".", ",", " ", "'", ""];
const GROUPING: [&str; 2] = ["thousands", "indian"];
const POSITION: [&str; 4] = ["after-space", "after", "before-space", "before"];
const STYLE: [&str; 2] = ["symbol", "code"];
const NEGATIVE: [&str; 3] = ["minus", "minus-after-symbol", "parentheses"];
const TIME: [&str; 2] = ["24h", "12h"];
pub const DATE_PATTERNS: [&str; 22] = [
    "DD/MM/YYYY",
    "DD-MM-YYYY",
    "DD.MM.YYYY",
    "D/M/YYYY",
    "D.M.YYYY",
    "D-M-YYYY",
    "DD/MM/YY",
    "DD.MM.YY",
    "MM/DD/YYYY",
    "M/D/YYYY",
    "MM-DD-YYYY",
    "MM/DD/YY",
    "YYYY-MM-DD",
    "YYYY/MM/DD",
    "YYYY.MM.DD",
    "YY-MM-DD",
    "D MMM YYYY",
    "DD MMM YYYY",
    "D MMMM YYYY",
    "MMM D, YYYY",
    "MMMM D, YYYY",
    "YYYY MMM D",
];
pub const GRAPHICS: [&str; 3] = ["auto", "on", "off"];
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

/// The formats are eight strings, in this order.
const FORMAT_KEYS: [&str; 8] = ["decimal", "group", "grouping", "currencyPosition", "currencyStyle", "negative", "date", "time"];

fn default_formats() -> Map<String, Value> {
    let Value::Object(m) = json!({
        "decimal": ",", "group": ".", "grouping": "thousands", "currencyPosition": "after-space",
        "currencyStyle": "symbol", "negative": "minus", "date": "DD/MM/YYYY", "time": "24h"
    }) else {
        unreachable!("an object literal")
    };
    m
}

pub fn default_prefs() -> Map<String, Value> {
    let Value::Object(m) = json!({
        "theme": "system", "language": "en", "formats": Value::Object(default_formats()), "autoLockMinutes": 10,
        "updateCheck": true, "welcomeDone": false, "graphics": "auto", "graphicsFailed": false, "keepInTray": false, "insights": true
    }) else {
        unreachable!("an object literal")
    };
    m
}

/// `formatsFromLegacyLocale`.
fn formats_from_legacy_locale(locale: Option<&str>) -> Map<String, Value> {
    let mut f = default_formats();
    let set = |f: &mut Map<String, Value>, pairs: &[(&str, &str)]| pairs.iter().for_each(|(k, v)| drop(f.insert((*k).into(), json!(v))));
    match locale {
        Some("en-US") => {
            set(&mut f, &[("decimal", "."), ("group", ","), ("currencyPosition", "before"), ("date", "MM/DD/YYYY"), ("time", "12h")])
        }
        Some("en-GB" | "en-BE") => set(&mut f, &[("decimal", "."), ("group", ","), ("currencyPosition", "before")]),
        _ => {}
    }
    f
}

/// `normalizeFormats`: unknown values fall back to `base`, and the two separators never clash. `input` is whatever was
/// stored or sent; a field of something that is not an object counts as missing.
fn normalize_formats(input: &Value, base: &Map<String, Value>) -> Map<String, Value> {
    let lists: [&[&str]; 8] = [&DECIMAL, &GROUP, &GROUPING, &POSITION, &STYLE, &NEGATIVE, &DATE_PATTERNS, &TIME];
    let mut out = Map::new();
    for (key, list) in FORMAT_KEYS.iter().zip(lists) {
        let picked = input.get(*key).and_then(Value::as_str).filter(|v| list.contains(v));
        let value = picked.map_or_else(|| base.get(*key).cloned().unwrap_or(Value::Null), |v| json!(v));
        out.insert((*key).into(), value);
    }
    if out["group"] == out["decimal"] {
        let fixed = if out["decimal"] == json!(",") { "." } else { "," };
        out.insert("group".into(), json!(fixed));
    }
    out
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

pub struct PrefsFile {
    file: Option<PathBuf>,
    system_languages: Vec<String>,
    cache: Option<Map<String, Value>>,
}

impl PrefsFile {
    pub fn new(file: Option<PathBuf>, system_languages: Vec<String>) -> Self {
        Self { file, system_languages, cache: None }
    }

    /// `getPrefs`: the file laid over the defaults, loaded once.
    pub fn get(&mut self) -> AppResult<Map<String, Value>> {
        if let Some(cache) = &self.cache {
            return Ok(cache.clone());
        }
        let raw = read_raw(self.file.as_deref());
        // `null` in the file: reading `raw.formats` throws in the TypeScript core.
        if raw.is_null() {
            return Err(AppError::failed());
        }
        // Older versions stored one "format locale"; it becomes the separate choices once.
        let formats = if truthy(raw.get("formats")) {
            normalize_formats(&raw["formats"], &default_formats())
        } else {
            formats_from_legacy_locale(raw.get("formatLocale").and_then(Value::as_str))
        };
        let mut prefs = default_prefs();
        if let Value::Object(rest) = &raw {
            for (key, value) in rest {
                if key != "formatLocale" {
                    prefs.insert(key.clone(), value.clone());
                }
            }
        }
        prefs.insert("formats".into(), Value::Object(formats));
        // First start: follow the system language when Kasboek has it.
        let stored = raw.get("language");
        let known = stored.and_then(Value::as_str).is_some_and(|l| LANGUAGES.contains(&l));
        if !truthy(stored) || !known {
            let language = if truthy(stored) { "en" } else { pick_language(&self.system_languages) };
            prefs.insert("language".into(), json!(language));
        }
        self.cache = Some(prefs.clone());
        Ok(prefs)
    }

    /// `updatePrefs`: `patch` holds only the keys that change (`formats` only the parts that change). The cache changes
    /// before the file is written, as in TypeScript.
    pub fn update(&mut self, patch: &Map<String, Value>) -> AppResult<Map<String, Value>> {
        let current = self.get()?;
        let current_formats = current["formats"].as_object().cloned().unwrap_or_default();
        let formats = match patch.get("formats") {
            Some(part) => {
                let mut merged = current_formats.clone();
                if let Value::Object(changes) = part {
                    merged.extend(changes.clone());
                }
                normalize_formats(&Value::Object(merged), &current_formats)
            }
            None => current_formats,
        };
        let mut next = current;
        for (key, value) in patch {
            next.insert(key.clone(), value.clone());
        }
        next.insert("formats".into(), Value::Object(formats));
        self.cache = Some(next.clone());
        let file = self.file.as_ref().ok_or_else(AppError::failed)?;
        let tmp = PathBuf::from(format!("{}.tmp", file.display()));
        let text = serde_json::to_string_pretty(&Value::Object(next.clone())).map_err(|_| AppError::failed())?;
        std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, file)).map_err(|_| AppError::failed())?;
        Ok(next)
    }
}

/// The parsed file, `{}` when it is missing, unreadable or not JSON. Anything that is not an object counts as empty
/// (the TypeScript spread of a string or array would add index keys; no file the app writes looks like that).
fn read_raw(file: Option<&Path>) -> Value {
    let parsed = file.and_then(|f| std::fs::read_to_string(f).ok()).and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match parsed {
        Some(Value::Null) => Value::Null,
        Some(v @ Value::Object(_)) => v,
        _ => Value::Object(Map::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(text: Option<&str>, languages: &[&str]) -> (tempfile::TempDir, PrefsFile) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        if let Some(t) = text {
            std::fs::write(&file, t).unwrap();
        }
        (dir, PrefsFile::new(Some(file), languages.iter().map(|s| (*s).to_owned()).collect()))
    }

    #[test]
    fn a_missing_file_gives_the_defaults_in_the_system_language() {
        let (_d, mut p) = prefs(None, &["nl-BE", "en-US"]);
        let got = p.get().unwrap();
        assert_eq!(got["language"], "nl");
        assert_eq!(got["theme"], "system");
        assert_eq!(got["formats"]["decimal"], ",");
    }

    #[test]
    fn unknown_keys_survive_a_write_and_legacy_locale_is_upgraded() {
        let (d, mut p) = prefs(Some(r#"{"language":"de","formatLocale":"en-US","extra":{"a":[1,2]},"theme":"dark"}"#), &[]);
        let got = p.get().unwrap();
        assert_eq!(got["formats"]["date"], "MM/DD/YYYY");
        assert!(!got.contains_key("formatLocale"));
        let out = p.update(json!({"autoLockMinutes": 5, "formats": {"group": ",", "decimal": ","}}).as_object().unwrap()).unwrap();
        assert_eq!(out["formats"]["decimal"], ",");
        assert_eq!(out["formats"]["group"], ".", "a clashing separator is moved");
        let written: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("prefs.json")).unwrap()).unwrap();
        assert_eq!(written["extra"], json!({"a": [1, 2]}));
        assert_eq!(written["autoLockMinutes"], 5);
        assert!(!d.path().join("prefs.json.tmp").exists());
    }

    #[test]
    fn language_choice() {
        let l = |v: &[&str]| pick_language(&v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        assert_eq!(l(&["es_MX"]), "es-419");
        assert_eq!(l(&["es-ES"]), "es");
        assert_eq!(l(&["pt-br"]), "pt-BR");
        assert_eq!(l(&["pt"]), "pt-PT");
        assert_eq!(l(&["ja", "FR"]), "fr");
        assert_eq!(l(&[]), "en");
        let (_d, mut p) = prefs(Some(r#"{"language":"xx"}"#), &["fr"]);
        assert_eq!(p.get().unwrap()["language"], "en", "an unknown stored language is English, not the system's");
    }
}
