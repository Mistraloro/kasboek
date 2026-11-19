//! The commands. Kept thin: each one calls a library function and prints what came back.
use kb_crypto::aead::Sealed;
use kb_crypto::encoding::{base32_decode, base32_encode, hex_decode, hex_encode};
use kb_crypto::recovery::normalize_recovery_key;
use kb_crypto::slot::{make_slot_with, open_slot, Argon2Cost, Slot, SlotKind, PASSWORD_KDF};
use kb_crypto::syncfile::{open_sync_file, seal_sync_file};
use kb_crypto::totp::{totp_at, verify_totp, DIGITS};
use kb_crypto::transfer::{encode_transfer, open_transfer, read_transfer_header, AuthMode, Credential, TransferInput, TransferKind};
use kb_crypto::vault::{open_vault, seal_vault, Vault};
use kb_db::{Cell, DbKey, OpenOptions, SqliteStore, Store};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub struct CliError {
    pub code: String,
    pub message: String,
}

fn fail<T>(code: &str, message: impl ToString) -> Result<T, CliError> {
    Err(CliError { code: code.into(), message: message.to_string() })
}

macro_rules! lib_error {
    ($($t:ty),*) => {$(
        impl From<$t> for CliError {
            fn from(e: $t) -> Self {
                CliError { code: e.code().into(), message: e.to_string() }
            }
        }
    )*};
}
lib_error!(kb_crypto::CryptoError, kb_crypto::transfer::TransferError, kb_db::DbError);

impl From<kb_core::AppError> for CliError {
    fn from(e: kb_core::AppError) -> Self {
        CliError { code: e.code, message: e.message }
    }
}

impl From<kb_crypto::syncfile::SyncFileError> for CliError {
    fn from(e: kb_crypto::syncfile::SyncFileError) -> Self {
        CliError { code: "sync.file".into(), message: e.to_string() }
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        CliError { code: "io".into(), message: e.to_string() }
    }
}

impl From<serde_json::Error> for CliError {
    fn from(e: serde_json::Error) -> Self {
        CliError { code: "json".into(), message: e.to_string() }
    }
}

const HELP: &str = "commands:
  scenario <file.json>                      run a scenario of ops through kb-core on a fresh database; prints results and a dump
  db-create <file> <keyhex> <schema>        create a database migrated to schema 1..15
  db-open <file> <keyhex> [--no-migrate]    open; print schema version, row counts, integrity
  db-migrate <file> <keyhex>                migrate to the current schema
  db-dump <file> <keyhex>                   canonical dump of the database as it is (no migration)
  db-snapshot <file> <keyhex> <target>      VACUUM INTO
  db-fx <file> <keyhex>                     stdin: [[cents, from, date, to], ...]; prints [{type, value}, ...]
  slot-make <password|recovery> <masterhex> <secret> [m t p]
  slot-open <password|recovery> <secret>    stdin: slot JSON; prints the master key as hex
  vault-seal <masterhex>                    stdin: vault JSON; prints the sealed JSON
  vault-open <masterhex>                    stdin: sealed JSON; prints the vault JSON
  totp <base32> <unixSeconds> [digits]
  totp-verify <base32> <code> <lastStep> <nowSeconds>
  base32-encode <hex> | base32-decode <text> | recovery-normalize <text>
  transfer-header <file>
  transfer-open <file> <outDb> <nowSeconds> password <password> [code] | recovery <key>
  transfer-make <specFile> <dbFile> <out>   spec: header fields, masterHex, vault, slots
  sync-make <keyhex> <out>                  stdin: {header, payload}
  sync-open <keyhex> <file>                 stdin: expected header entries; prints the payload";

pub fn run(args: &[String]) -> Result<String, CliError> {
    let arg = |i: usize| -> Result<&str, CliError> {
        args.get(i).map(String::as_str).ok_or_else(|| CliError { code: "usage".into(), message: format!("missing argument {i}\n{HELP}") })
    };
    match arg(0)? {
        "help" => Ok(HELP.into()),
        "scenario" => crate::scenario::run(arg(1)?),
        "db-create" => {
            let schema: u32 = arg(3)?.parse().map_err(|_| CliError { code: "usage".into(), message: "schema must be a number".into() })?;
            let store = open(arg(1)?, arg(2)?, false)?;
            store.migrate_to(schema)?;
            Ok(json!({ "schemaVersion": store.schema_version()? }).to_string())
        }
        "db-open" => {
            let store = open(arg(1)?, arg(2)?, args.get(3).map(String::as_str) != Some("--no-migrate"))?;
            let tables: Map<String, Value> = store.table_counts()?.into_iter().map(|(name, n)| (name, json!(n))).collect();
            Ok(json!({ "schemaVersion": store.schema_version()?, "tables": tables, "integrityOk": store.integrity_ok()? }).to_string())
        }
        "db-migrate" => {
            let store = open(arg(1)?, arg(2)?, false)?;
            store.migrate()?;
            Ok(json!({ "schemaVersion": store.schema_version()? }).to_string())
        }
        "db-dump" => Ok(open(arg(1)?, arg(2)?, false)?.canonical_dump()?),
        "db-snapshot" => {
            open(arg(1)?, arg(2)?, true)?.snapshot_encrypted(Path::new(arg(3)?))?;
            Ok(json!({ "ok": true }).to_string())
        }
        "db-fx" => db_fx(arg(1)?, arg(2)?),
        "slot-make" => {
            let master = master(arg(2)?)?;
            let cost = match (args.get(4), args.get(5), args.get(6)) {
                (Some(m), Some(t), Some(p)) => Argon2Cost { m: number(m)?, t: number(t)?, p: number(p)? },
                _ => PASSWORD_KDF,
            };
            Ok(serde_json::to_string(&make_slot_with(&master, arg(3)?, kind(arg(1)?)?, cost)?)?)
        }
        "slot-open" => {
            let slot: Slot = serde_json::from_str(&stdin()?)?;
            match open_slot(&slot, arg(2)?, kind(arg(1)?)?)? {
                Some(master) => Ok(json!({ "master": hex_encode(*master) }).to_string()),
                None => fail("slot.wrong_secret", "the secret does not open this slot"),
            }
        }
        "vault-seal" => {
            let vault: Vault = serde_json::from_str(&stdin()?)?;
            let master = master(arg(1)?)?;
            Ok(serde_json::to_string(&seal_vault(&master, &vault))?)
        }
        "vault-open" => {
            let sealed: Sealed = serde_json::from_str(&stdin()?)?;
            let master = master(arg(1)?)?;
            Ok(serde_json::to_string(&open_vault(&master, &sealed)?)?)
        }
        "totp" => {
            let digits =
                args.get(3).map_or(Ok(DIGITS), |d| d.parse().map_err(|_| CliError { code: "usage".into(), message: "digits".into() }))?;
            Ok(json!({ "code": totp_at(arg(1)?, arg(2)?.parse().map_err(|_| CliError { code: "usage".into(), message: "seconds".into() })?, digits)? }).to_string())
        }
        "totp-verify" => {
            let (last, now): (i64, f64) = (number(arg(3)?)?, number(arg(4)?)?);
            Ok(json!({ "step": verify_totp(arg(1)?, arg(2)?, last, now)? }).to_string())
        }
        "base32-encode" => Ok(
            json!({ "text": base32_encode(&hex_decode(arg(1)?).map_err(|e| CliError { code: "usage".into(), message: e.to_string() })?) })
                .to_string(),
        ),
        "base32-decode" => Ok(json!({ "hex": hex_encode(base32_decode(arg(1)?)?) }).to_string()),
        "recovery-normalize" => Ok(json!({ "text": normalize_recovery_key(arg(1)?) }).to_string()),
        "transfer-header" => Ok(serde_json::to_string(&read_transfer_header(&std::fs::read(arg(1)?)?)?)?),
        "transfer-open" => {
            let credential = match arg(4)? {
                "password" => Credential::Password { password: arg(5)?, code: args.get(6).map(String::as_str) },
                "recovery" => Credential::RecoveryKey(arg(5)?),
                other => return fail("usage", format!("unknown credential kind {other}")),
            };
            let contents = open_transfer(&std::fs::read(arg(1)?)?, &credential, number(arg(3)?)?)?;
            std::fs::write(arg(2)?, &contents.db_file)?;
            Ok(json!({
                "header": contents.header,
                "master": hex_encode(*contents.master),
                "vault": contents.vault,
                "usedRecovery": contents.used_recovery,
                "dbSha256": hex_encode(Sha256::digest(&contents.db_file)),
            })
            .to_string())
        }
        "transfer-make" => transfer_make(arg(1)?, arg(2)?, arg(3)?),
        "sync-make" => {
            let key = key32(arg(1)?)?;
            let doc: Value = serde_json::from_str(&stdin()?)?;
            let header = doc["header"].as_object().cloned().unwrap_or_default();
            std::fs::write(arg(2)?, seal_sync_file(&key, &header, &doc["payload"]))?;
            Ok(json!({ "ok": true }).to_string())
        }
        "sync-open" => {
            let expect: Map<String, Value> = serde_json::from_str(&stdin()?)?;
            let payload: Value = open_sync_file(&key32(arg(1)?)?, &std::fs::read(arg(2)?)?, &expect)?;
            Ok(payload.to_string())
        }
        other => fail("usage", format!("unknown command {other}\n{HELP}")),
    }
}

fn open(file: &str, key: &str, migrate: bool) -> Result<SqliteStore, CliError> {
    Ok(SqliteStore::open(Path::new(file), &DbKey::from_hex(key)?, OpenOptions { migrate })?)
}

fn stdin() -> Result<String, CliError> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    Ok(text)
}

fn number<T: std::str::FromStr>(text: &str) -> Result<T, CliError> {
    text.parse().map_err(|_| CliError { code: "usage".into(), message: format!("not a number: {text}") })
}

fn kind(text: &str) -> Result<SlotKind, CliError> {
    match text {
        "password" => Ok(SlotKind::Password),
        "recovery" => Ok(SlotKind::Recovery),
        other => fail("usage", format!("slot kind must be password or recovery, not {other}")),
    }
}

fn key32(hex: &str) -> Result<[u8; 32], CliError> {
    hex_decode(hex).ok().and_then(|b| b.try_into().ok()).map_or_else(|| fail("usage", "a key is 64 hex characters"), Ok)
}

fn master(hex: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, CliError> {
    Ok(zeroize::Zeroizing::new(key32(hex)?))
}

fn cell(value: &Value) -> Cell {
    match value {
        Value::Null => Cell::Null,
        Value::Number(n) if n.is_i64() => Cell::Int(n.as_i64().expect("checked")),
        Value::Number(n) => Cell::Real(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Cell::Text(s.clone()),
        other => Cell::Text(other.to_string()),
    }
}

fn db_fx(file: &str, key: &str) -> Result<String, CliError> {
    let store = open(file, key, true)?;
    let cases: Vec<[Value; 4]> = serde_json::from_str(&stdin()?)?;
    let mut results = Vec::new();
    for [cents, from, date, to] in &cases {
        results.push(match store.probe_fx([cell(cents), cell(from), cell(date), cell(to)])? {
            Cell::Null => json!({ "type": "null", "value": null }),
            Cell::Int(i) => json!({ "type": "integer", "value": i }),
            Cell::Real(r) => json!({ "type": "real", "value": r }),
            Cell::Text(t) => json!({ "type": "text", "value": t }),
            Cell::Blob(_) => json!({ "type": "blob", "value": null }),
        });
    }
    Ok(Value::Array(results).to_string())
}

fn transfer_make(spec_file: &str, db_file: &str, out: &str) -> Result<String, CliError> {
    let spec: Value = serde_json::from_slice(&std::fs::read(spec_file)?)?;
    let text = |field: &str| spec[field].as_str().unwrap_or_default().to_owned();
    let vault: Vault = serde_json::from_value(spec["vault"].clone())?;
    let master = master(&text("masterHex"))?;
    let db = std::fs::read(db_file)?;
    let input = TransferInput {
        kind: if text("kind") == "backup" { TransferKind::Backup } else { TransferKind::Export },
        created_at: text("createdAt"),
        app_version: text("appVersion"),
        schema_version: spec["schemaVersion"].as_u64().unwrap_or(0) as u32,
        mode: if text("mode") == "device" { AuthMode::Device } else { AuthMode::Password },
        two_factor: spec["twoFactor"].as_bool().unwrap_or(false),
        password_slot: spec.get("passwordSlot").filter(|v| !v.is_null()).map(|v| serde_json::from_value(v.clone())).transpose()?,
        recovery_slot: serde_json::from_value(spec["recoverySlot"].clone())?,
        master: &master,
        vault: &vault,
        db_file: &db,
    };
    std::fs::write(out, encode_transfer(&input)?)?;
    Ok(json!({ "ok": true }).to_string())
}
