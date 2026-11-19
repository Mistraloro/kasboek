//! Texts against i18next 27 on the same keys, all 8 languages (tests/fixtures/i18next.json, from tools/gen-fixtures.mjs).
use kb_i18n::{Catalog, LANGUAGES};
use serde_json::Value;

#[test]
fn texts_match_i18next() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/i18next.json")).unwrap();
    let vars: Vec<(String, String)> = fixture["vars"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string)))
        .collect();
    let vars: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let catalogs: Vec<(&str, Catalog)> = LANGUAGES.iter().map(|l| (*l, Catalog::new(l))).collect();
    let mut checked = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let [lng, key, count, want] = case.as_array().unwrap().as_slice() else { panic!("bad case") };
        let catalog = &catalogs.iter().find(|(l, _)| l == &lng.as_str().unwrap()).unwrap().1;
        let got = catalog.tn(key.as_str().unwrap(), count.as_i64(), &vars);
        assert_eq!(&got, want.as_str().unwrap(), "{lng} {key} count {count}");
        checked += 1;
    }
    assert!(checked > 2000, "only {checked} cases");
}

#[test]
fn language_codes_follow_the_renderer() {
    assert_eq!(kb_i18n::normalize("nl-BE"), "nl");
    assert_eq!(kb_i18n::normalize("es-MX"), "es-419");
    assert_eq!(kb_i18n::normalize("pt_BR"), "pt-BR");
    assert_eq!(kb_i18n::normalize("ja"), "en");
}
