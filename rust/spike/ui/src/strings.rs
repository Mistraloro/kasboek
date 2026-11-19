//! Texts from the Electron app's locale files (src/renderer/src/i18n/locales/*.json). English always, plus `de` and `fr`
//! for the long-string check; a key missing in the chosen language falls back to English like the app does.
use serde_json::Value;

const EN_JSON: &str = include_str!("../../../../src/renderer/src/i18n/locales/en.json");
const DE_JSON: &str = include_str!("../../../../src/renderer/src/i18n/locales/de.json");
const FR_JSON: &str = include_str!("../../../../src/renderer/src/i18n/locales/fr.json");

pub struct Locale {
    chosen: Value,
    en: Value,
}

impl Locale {
    /// `en`, `de` or `fr`. Anything else is English.
    pub fn load_lang(lang: &str) -> Self {
        let en: Value = serde_json::from_str(EN_JSON).expect("en.json");
        let chosen = match lang {
            "de" => serde_json::from_str(DE_JSON).expect("de.json"),
            "fr" => serde_json::from_str(FR_JSON).expect("fr.json"),
            _ => en.clone(),
        };
        Locale { chosen, en }
    }

    /// Text for a dotted key with `{{name}}` placeholders replaced.
    pub fn t(&self, key: &str, vars: &[(&str, &str)]) -> String {
        let mut s = lookup(&self.chosen, key)
            .or_else(|| lookup(&self.en, key))
            .unwrap_or_else(|| panic!("missing key {key}"))
            .to_string();
        for (name, value) in vars {
            s = s.replace(&format!("{{{{{name}}}}}"), value);
        }
        s
    }
}

fn lookup<'a>(root: &'a Value, key: &str) -> Option<&'a str> {
    let mut v = root;
    for part in key.split('.') {
        v = v.get(part)?;
    }
    v.as_str()
}
