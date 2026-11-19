//! Every rule against the answers of the TypeScript original (tests/fixtures/rules.json, from tools/gen-fixtures.mjs).
use kb_rules::iban::{find_ibans, mask_iban, mask_numbers, valid_iban};
use kb_rules::password::{check_password, MIN_PASSWORD_LENGTH};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/rules.json")).unwrap()
}

#[test]
fn passwords_match_typescript() {
    for case in fixtures()["passwords"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let got = check_password(input);
        let issues: Vec<&str> = got.issues.iter().map(|i| i.as_str()).collect();
        let want: Vec<&str> = case["issues"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(issues, want, "issues of {input:?}");
        assert_eq!(got.strength as u64, case["strength"].as_u64().unwrap(), "strength of {input:?}");
        assert_eq!(got.bits as u64, case["bits"].as_u64().unwrap(), "bits of {input:?}");
        assert_eq!(got.classes as u64, case["classes"].as_u64().unwrap(), "classes of {input:?}");
        assert_eq!(got.ok, case["ok"].as_bool().unwrap(), "ok of {input:?}");
    }
}

#[test]
fn ibans_match_typescript() {
    for case in fixtures()["iban"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        assert_eq!(mask_iban(input), case["mask"].as_str().unwrap(), "maskIban of {input:?}");
        let found: Vec<String> = case["found"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(find_ibans(input), found, "findIbans of {input:?}");
        assert_eq!(mask_numbers(input), case["numbers"].as_str().unwrap(), "maskNumbers of {input:?}");
    }
    for case in fixtures()["valid"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        assert_eq!(valid_iban(input), case["valid"].as_bool().unwrap(), "validIban of {input:?}");
    }
}

#[test]
fn the_documented_password_is_fine() {
    assert_eq!(MIN_PASSWORD_LENGTH, 12);
    assert!(check_password("kraan-tulp-Ober-7-fiets-mist").ok);
}
