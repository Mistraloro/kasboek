//! Texts from the Electron app's English locale (src/renderer/src/i18n/locales/en.json).
use serde_json::Value;

const EN_JSON: &str = include_str!("../../../../src/renderer/src/i18n/locales/en.json");

pub struct En(Value);

impl En {
    pub fn load() -> Self {
        En(serde_json::from_str(EN_JSON).expect("en.json"))
    }

    /// Text for a dotted key with `{{name}}` placeholders replaced.
    pub fn t(&self, key: &str, vars: &[(&str, &str)]) -> String {
        let mut v = &self.0;
        for part in key.split('.') {
            v = v.get(part).unwrap_or_else(|| panic!("missing key {key}"));
        }
        let mut s = v
            .as_str()
            .unwrap_or_else(|| panic!("not a string: {key}"))
            .to_string();
        for (name, value) in vars {
            s = s.replace(&format!("{{{{{name}}}}}"), value);
        }
        s
    }
}
