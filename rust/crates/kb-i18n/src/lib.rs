//! The renderer's texts (`src/renderer/src/i18n/locales/*.json`) for the native app, looked up the way i18next does it for
//! the settings of `src/renderer/src/i18n/index.ts`: dotted keys into nested JSON, `{{name}}` interpolation without
//! escaping (a variable nobody gave stays as written, `ai` and `aiCompany` always known), plural suffixes from `count`, the
//! regional variants falling back to their base language and then to English, a missing key answering with the key.
//!
//! Keys the native app adds (the loading steps) live in `locales/extra.<lang>.json` here and are merged over the
//! renderer's files at load, so the Electron renderer's files stay untouched.
use serde_json::Value;

pub const LANGUAGES: [&str; 8] = ["en", "nl", "fr", "de", "es", "es-419", "pt-PT", "pt-BR"];

macro_rules! bundle {
    ($file:literal, $extra:literal) => {
        (include_str!(concat!("../../../../src/renderer/src/i18n/locales/", $file)), include_str!(concat!("../locales/", $extra)))
    };
}

fn sources(lang: &str) -> Option<(&'static str, &'static str)> {
    Some(match lang {
        "en" => bundle!("en.json", "extra.en.json"),
        "nl" => bundle!("nl.json", "extra.nl.json"),
        "fr" => bundle!("fr.json", "extra.fr.json"),
        "de" => bundle!("de.json", "extra.de.json"),
        "es" => bundle!("es.json", "extra.es.json"),
        "es-419" => bundle!("es-419.json", "extra.es-419.json"),
        "pt-PT" => bundle!("pt-PT.json", "extra.pt-PT.json"),
        "pt-BR" => bundle!("pt-BR.json", "extra.pt-BR.json"),
        _ => return None,
    })
}

/// `FALLBACKS` of src/shared/languages.ts (English always comes last).
fn fallbacks(lang: &str) -> &'static [&'static str] {
    match lang {
        "es-419" => &["es"],
        "pt-BR" => &["pt-PT"],
        _ => &[],
    }
}

fn merge(base: &mut Value, extra: Value) {
    match (base, extra) {
        (Value::Object(b), Value::Object(e)) => {
            for (k, v) in e {
                match b.get_mut(&k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (slot, e) => *slot = e,
    }
}

fn parse(lang: &str) -> Value {
    let (main, extra) = sources(lang).expect("language is in LANGUAGES");
    let mut v: Value = serde_json::from_str(main).expect("locale file");
    merge(&mut v, serde_json::from_str(extra).expect("extra locale file"));
    v
}

/// The language code to use for an arbitrary one (`nl-BE` -> `nl`), English when unknown.
pub fn normalize(code: &str) -> &'static str {
    let tag = code.replace('_', "-");
    if let Some(l) = LANGUAGES.iter().find(|l| l.eq_ignore_ascii_case(&tag)) {
        return l;
    }
    let (base, region) = tag.split_once('-').unwrap_or((&tag, ""));
    match base.to_lowercase().as_str() {
        "es" => {
            if !region.is_empty() && !region.eq_ignore_ascii_case("ES") {
                "es-419"
            } else {
                "es"
            }
        }
        "pt" => {
            if region.eq_ignore_ascii_case("BR") {
                "pt-BR"
            } else {
                "pt-PT"
            }
        }
        b => LANGUAGES.iter().find(|l| **l == b).copied().unwrap_or("en"),
    }
}

/// CLDR plural category of a whole number (what `Intl.PluralRules` gives for the eight languages).
pub fn plural_category(lang: &str, n: i64) -> &'static str {
    let n = n.unsigned_abs();
    let millions = n != 0 && n % 1_000_000 == 0;
    match lang {
        "en" | "nl" | "de" => {
            if n == 1 {
                "one"
            } else {
                "other"
            }
        }
        "es" | "es-419" => {
            if n == 1 {
                "one"
            } else if millions {
                "many"
            } else {
                "other"
            }
        }
        "fr" | "pt-BR" => {
            if n <= 1 {
                "one"
            } else if millions {
                "many"
            } else {
                "other"
            }
        }
        "pt-PT" => {
            if n == 1 {
                "one"
            } else if millions {
                "many"
            } else {
                "other"
            }
        }
        _ => {
            if n == 1 {
                "one"
            } else {
                "other"
            }
        }
    }
}

pub struct Catalog {
    lang: &'static str,
    /// The language, its fallbacks, English: the order i18next tries them in.
    chain: Vec<(&'static str, Value)>,
}

impl Catalog {
    pub fn new(lang: &str) -> Self {
        let lang = normalize(lang);
        let mut codes = vec![lang];
        codes.extend(fallbacks(lang));
        if !codes.contains(&"en") {
            codes.push("en");
        }
        Self { lang, chain: codes.into_iter().map(|c| (c, parse(c))).collect() }
    }

    pub fn lang(&self) -> &'static str {
        self.lang
    }

    fn get<'a>(root: &'a Value, key: &str) -> Option<&'a str> {
        let mut v = root;
        for part in key.split('.') {
            v = v.get(part)?;
        }
        v.as_str()
    }

    fn lookup(&self, key: &str, count: Option<i64>) -> Option<&str> {
        for (code, root) in &self.chain {
            // The order i18next tries: zero (count 0 only), the plural suffix, the plain key, `_other`.
            let mut keys: Vec<String> = Vec::new();
            if let Some(n) = count {
                if n == 0 {
                    keys.push(format!("{key}_zero"));
                }
                keys.push(format!("{key}_{}", plural_category(code, n)));
            }
            keys.push(key.to_string());
            if count.is_some() {
                keys.push(format!("{key}_other"));
            }
            if let Some(found) = keys.iter().find_map(|k| Self::get(root, k)) {
                return Some(found);
            }
        }
        None
    }

    /// The text for `key`. A missing key answers with the key itself.
    pub fn t(&self, key: &str) -> String {
        self.tn(key, None, &[])
    }

    /// With variables (`{{name}}`).
    pub fn tv(&self, key: &str, vars: &[(&str, &str)]) -> String {
        self.tn(key, None, vars)
    }

    /// With a `count` (plural suffix and `{{count}}`) and more variables.
    pub fn tn(&self, key: &str, count: Option<i64>, vars: &[(&str, &str)]) -> String {
        let Some(text) = self.lookup(key, count) else { return key.to_string() };
        interpolate(text, count, vars)
    }
}

fn interpolate(text: &str, count: Option<i64>, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        out.push_str(&rest[..start]);
        let name = rest[start + 2..start + 2 + len].trim();
        let value = match name {
            _ if vars.iter().any(|(k, _)| *k == name) => vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string()),
            "count" => count.map(|c| c.to_string()),
            "ai" => Some("Claude".to_string()),
            "aiCompany" => Some("Anthropic".to_string()),
            _ => None,
        };
        // A variable nobody gave stays as it is written, like i18next leaves it.
        let value = value.unwrap_or_else(|| rest[start..start + 2 + len + 2].to_string());
        out.push_str(&value);
        rest = &rest[start + 2 + len + 2..];
    }
    out.push_str(rest);
    out
}
