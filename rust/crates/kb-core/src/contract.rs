//! `contract.json`: the contract of the app as the parity suite dumps it from the TypeScript sources (rust/parity/
//! dump-contract.ts). The currency list in it is the static table of Node's ICU (`Intl.supportedValuesOf`), which the
//! validation needs; the rest is what the tests compare the registry and the defaults against.
use serde_json::Value;
use std::sync::OnceLock;

pub const CONTRACT_JSON: &str = include_str!("../contract.json");

pub fn contract() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(CONTRACT_JSON).expect("contract.json is valid JSON"))
}

pub fn currencies() -> &'static [String] {
    static LIST: OnceLock<Vec<String>> = OnceLock::new();
    LIST.get_or_init(|| {
        contract()["enums"]["currencies"].as_array().expect("currencies").iter().filter_map(|c| c.as_str().map(str::to_owned)).collect()
    })
}
