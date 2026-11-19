//! The registry against `contract.json`, which the parity suite dumps from the TypeScript sources.
use kb_core::contract::contract;
use kb_core::table::{OPS, PUBLIC_OPS};
use kb_core::{Actor, PORTED};
use serde_json::{json, Value};

mod common;

#[test]
fn the_op_list_and_flags_equal_contract_json() {
    let ops = contract()["ops"].as_array().unwrap();
    assert_eq!(ops.len(), 154);
    assert_eq!(contract()["opCount"], 154);
    assert_eq!(OPS.len(), ops.len(), "the registry must list every operation of the contract");
    for (ts, (name, mutates, assistant)) in ops.iter().zip(OPS) {
        assert_eq!(ts["name"], *name, "same names in the same order");
        assert_eq!(ts["mutates"], *mutates, "mutates of {name}");
        assert_eq!(ts["assistant"], *assistant, "assistant of {name}");
        assert_eq!(ts["public"], PUBLIC_OPS.contains(name), "public of {name}");
    }
    let public: Vec<&str> = ops.iter().filter(|o| o["public"] == true).map(|o| o["name"].as_str().unwrap()).collect();
    assert_eq!(public, PUBLIC_OPS, "PUBLIC_OPS in the same order");
}

#[test]
fn every_unported_operation_says_so_and_every_ported_one_exists() {
    let f = common::fresh();
    for name in PORTED {
        assert!(OPS.iter().any(|(n, _, _)| n == name), "{name} is in the contract");
    }
    assert_eq!(PORTED.len(), 30);
    for (name, _, _) in OPS {
        let result = f.core.dispatch(name, json!({}), Actor::User);
        let ported = PORTED.contains(name);
        match result {
            Err(e) if e.code == "op.not_ported" => assert!(!ported, "{name} is listed as ported but answers op.not_ported"),
            _ => assert!(ported, "{name} answered although it is not listed as ported"),
        }
    }
}

#[test]
fn enums_and_defaults_equal_the_typescript_ones() {
    let c = contract();
    assert_eq!(Value::from(kb_core::prefs::LANGUAGES.to_vec()), c["enums"]["languages"]);
    assert_eq!(Value::from(kb_core::prefs::GRAPHICS.to_vec()), c["enums"]["graphics"]);
    assert_eq!(Value::from(kb_core::prefs::DATE_PATTERNS.to_vec()), c["enums"]["format"]["date"]);
    assert_eq!(Value::Object(kb_core::settings::defaults()), c["defaults"]["settings"]);
    assert_eq!(Value::Object(kb_core::prefs::default_prefs())["formats"], c["defaults"]["formats"]);
    assert!(kb_core::contract::currencies().iter().any(|c| c == "EUR"));
}

/// The JSON Schemas of the contract say what the typed inputs must accept: the keys of each ported operation's input are
/// the keys its schema lists (a field added on one side only is caught here).
#[test]
fn the_input_keys_of_ported_operations_are_the_schema_keys() {
    let f = common::fresh();
    for op in contract()["ops"].as_array().unwrap().iter().filter(|o| PORTED.contains(&o["name"].as_str().unwrap())) {
        let name = op["name"].as_str().unwrap();
        let props = op["input"]["properties"].as_object().cloned().unwrap_or_default();
        // An unknown key is always refused...
        assert_eq!(f.code(name, json!({"definitelyNotAField": 1})), "op.invalid_input", "{name}");
        // ...and no schema key is: with the key present, the failure (if any) is about its value or a missing field,
        // never "unknown field". serde's message names the field it does not know.
        for key in props.keys() {
            let err = f.op(name, json!({ key: null })).expect_err(name);
            assert!(!err.message.contains("unknown field"), "{name} does not know the field {key}: {}", err.message);
        }
    }
}
