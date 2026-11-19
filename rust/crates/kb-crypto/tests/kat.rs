//! Known-answer tests: fixtures made by the TypeScript core (rust/parity/fixtures, invented data) must read here.
use kb_crypto::aead::Sealed;
use kb_crypto::encoding::{base64_encode, hex_decode, hex_encode};
use kb_crypto::slot::{derive_slot_key, open_slot, Kdf, Slot, SlotKind};
use kb_crypto::syncfile::open_sync_file;
use kb_crypto::totp::totp_at;
use kb_crypto::transfer::{open_transfer, Credential, TransferError};
use kb_crypto::vault::{open_vault, seal_vault, Vault};
use serde_json::Value;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/fixtures")
}

fn kat() -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join("kat.json")).expect("fixtures/kat.json")).expect("valid JSON")
}

fn master(kat: &Value) -> [u8; 32] {
    hex_decode(kat["masterHex"].as_str().unwrap()).unwrap().try_into().unwrap()
}

fn slot(kat: &Value, name: &str) -> Slot {
    serde_json::from_value(kat["slots"][name].clone()).expect("a slot")
}

#[test]
fn derived_keys_match_independent_implementations() {
    let kat = kat();
    let v = &kat["kdfVectors"];
    let password = v["password"].as_str().unwrap();
    let salt = base64_encode(&hex_decode(v["saltHex"].as_str().unwrap()).unwrap());
    for name in ["default", "cheap"] {
        let a = &v["argon2id"][name];
        let kdf =
            Kdf::Argon2id { m: a["m"].as_u64().unwrap(), t: a["t"].as_u64().unwrap(), p: a["p"].as_u64().unwrap(), salt: salt.clone() };
        assert_eq!(hex_encode(*derive_slot_key(password, &kdf).unwrap()), a["keyHex"].as_str().unwrap(), "argon2id {name}");
    }
    let s = &v["scrypt"];
    let kdf = Kdf::Scrypt { n: s["N"].as_u64().unwrap(), r: s["r"].as_u64().unwrap(), p: s["p"].as_u64().unwrap(), salt: salt.clone() };
    assert_eq!(hex_encode(*derive_slot_key(password, &kdf).unwrap()), s["keyHex"].as_str().unwrap());
    let recovery = kat["recoveryKey"].as_str().unwrap();
    assert_eq!(hex_encode(*derive_slot_key(recovery, &Kdf::Hkdf { salt }).unwrap()), v["hkdf"]["keyHex"].as_str().unwrap());
}

#[test]
fn slots_made_by_typescript_open() {
    let kat = kat();
    let password = kat["password"].as_str().unwrap();
    for name in ["passwordDefault", "passwordCheap", "scrypt"] {
        let opened = open_slot(&slot(&kat, name), password, SlotKind::Password).unwrap().unwrap_or_else(|| panic!("{name} did not open"));
        assert_eq!(*opened, master(&kat), "{name}");
    }
    let recovery = open_slot(&slot(&kat, "recovery"), kat["recoveryKey"].as_str().unwrap(), SlotKind::Recovery).unwrap().unwrap();
    assert_eq!(*recovery, master(&kat));
    assert!(open_slot(&slot(&kat, "passwordCheap"), "wrong", SlotKind::Password).unwrap().is_none());
}

#[test]
fn the_vault_sealed_by_typescript_opens_and_a_rust_seal_opens_too() {
    let kat = kat();
    let sealed: Sealed = serde_json::from_value(kat["vault"]["sealed"].clone()).unwrap();
    let expected: Vault = serde_json::from_value(kat["vault"]["plain"].clone()).unwrap();
    assert_eq!(open_vault(&master(&kat), &sealed).unwrap(), expected);
    assert_eq!(open_vault(&master(&kat), &seal_vault(&master(&kat), &expected)).unwrap(), expected);
}

#[test]
fn rfc6238_vectors_from_the_fixture() {
    let kat = kat();
    let secret = kat["totp"]["secret"].as_str().unwrap();
    for pair in kat["totp"]["rfc6238Sha1Digits8"].as_array().unwrap() {
        let (time, code) = (pair[0].as_i64().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(totp_at(secret, time, 8).unwrap(), code);
    }
}

#[test]
fn exports_made_by_typescript_open() {
    let kat = kat();
    let t = &kat["transfer"];
    let password = kat["password"].as_str().unwrap();
    let file = std::fs::read(fixtures().join(t["file"].as_str().unwrap())).unwrap();
    let opened = open_transfer(&file, &Credential::Password { password, code: None }, 0.0).unwrap();
    assert_eq!(hex_encode(sha256(&opened.db_file)), t["dbSha256"].as_str().unwrap());
    assert_eq!(*opened.master, master(&kat));
    assert_eq!(opened.header.app_version, t["appVersion"].as_str().unwrap());
    assert_eq!(u64::from(opened.header.schema_version), t["schemaVersion"].as_u64().unwrap());

    let file2fa = std::fs::read(fixtures().join(t["file2fa"].as_str().unwrap())).unwrap();
    let now = t["totpNow"].as_f64().unwrap();
    let code = t["totpCode"].as_str().unwrap();
    let wrong = open_transfer(&file2fa, &Credential::Password { password, code: Some("000000") }, now);
    assert_eq!(wrong.err(), Some(TransferError::WrongCredentials));
    let ok = open_transfer(&file2fa, &Credential::Password { password, code: Some(code) }, now).unwrap();
    assert_eq!(ok.vault.totp.unwrap().last_step, (now / 30.0).floor() as i64);
    let by_recovery = open_transfer(&file2fa, &Credential::RecoveryKey(kat["recoveryKey"].as_str().unwrap()), now).unwrap();
    assert!(by_recovery.used_recovery);
}

#[test]
fn the_sync_file_made_by_typescript_opens() {
    let kat = kat();
    let s = &kat["sync"];
    let key: [u8; 32] = hex_decode(s["keyHex"].as_str().unwrap()).unwrap().try_into().unwrap();
    let file = std::fs::read(fixtures().join(s["file"].as_str().unwrap())).unwrap();
    let payload: Value = open_sync_file(&key, &file, s["header"].as_object().unwrap()).unwrap();
    assert_eq!(payload, s["payload"]);
    assert!(open_sync_file::<Value>(&[0u8; 32], &file, &serde_json::Map::new()).is_err());
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).to_vec()
}
