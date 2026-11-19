//! Kasboek export / backup file (.kasboek), format 2. Byte-compatible port of src/core/transfer-format.ts.
//!
//! ```text
//! "KASBOEK2" | uint32 BE header length | header JSON | ciphertext | 16-byte GCM tag
//! ```
//!
//! The payload (u32 vault length, vault JSON, still-encrypted database) is sealed with
//! HKDF(master, header.salt, "kasboek:file:v2"). The magic, length and header bytes are the associated data, so the
//! header cannot be changed. The reader uses the header bytes exactly as written.
use crate::aead::{hkdf, TAG_LEN};
use crate::encoding::base64_decode;
use crate::error::CryptoError;
use crate::slot::{open_slot, Slot, SlotKind};
use crate::totp::verify_totp;
use crate::vault::Vault;
use crate::{random_bytes, recovery::normalize_recovery_key, Master};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use std::fmt;
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"KASBOEK2";
const MAX_HEADER: usize = 64 * 1024;
const FILE_INFO: &str = "kasboek:file:v2";
pub const TRANSFER_EXTENSION: &str = "kasboek";

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Password,
    Device,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    Export,
    Backup,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransferSlots {
    pub recovery: Slot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<Slot>,
}

/// Field order is the order of `JSON.stringify` in the TypeScript encoder.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TransferHeader {
    pub format: u8,
    pub kind: TransferKind,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub mode: AuthMode,
    #[serde(rename = "twoFactor")]
    pub two_factor: bool,
    pub slots: TransferSlots,
    pub salt: String,
    pub iv: String,
}

/// Debug output never shows secrets (master key, vault, database bytes).
impl fmt::Debug for TransferInput<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransferInput")
            .field("kind", &self.kind)
            .field("created_at", &self.created_at)
            .field("mode", &self.mode)
            .field("master", &"<redacted>")
            .field("vault", &"<redacted>")
            .field("db_file_len", &self.db_file.len())
            .finish_non_exhaustive()
    }
}

/// Debug output never shows the password, code or recovery key.
impl fmt::Debug for Credential<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Credential::Password { <redacted> }"),
            Self::RecoveryKey(_) => f.write_str("Credential::RecoveryKey(<redacted>)"),
        }
    }
}

/// Debug output never shows the master key, vault or database bytes.
impl fmt::Debug for TransferContents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransferContents")
            .field("header", &self.header)
            .field("master", &"<redacted>")
            .field("vault", &"<redacted>")
            .field("db_file_len", &self.db_file.len())
            .field("used_recovery", &self.used_recovery)
            .finish()
    }
}

pub struct TransferInput<'a> {
    pub kind: TransferKind,
    /// ISO 8601 with milliseconds and `Z`, like `Date.prototype.toISOString`.
    pub created_at: String,
    pub app_version: String,
    pub schema_version: u32,
    pub mode: AuthMode,
    pub two_factor: bool,
    pub password_slot: Option<Slot>,
    pub recovery_slot: Slot,
    pub master: &'a [u8; 32],
    pub vault: &'a Vault,
    /// The database file as it is on disk (still encrypted).
    pub db_file: &'a [u8],
}

pub enum Credential<'a> {
    Password { password: &'a str, code: Option<&'a str> },
    RecoveryKey(&'a str),
}

pub struct TransferContents {
    pub header: TransferHeader,
    pub master: Master,
    pub vault: Vault,
    pub db_file: Vec<u8>,
    /// True when opened with the recovery key (the password should be reset).
    pub used_recovery: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransferError {
    #[error("This backup was made by an early test version and can't be imported.")]
    OldFormat,
    #[error("This file is not a Kasboek export.")]
    NotKasboek,
    #[error("This file is damaged.")]
    Corrupt,
    #[error("This file was made by a newer version of Kasboek.")]
    Unsupported,
    #[error("The login details don't match this file.")]
    WrongCredentials,
    #[error("This export comes from a passwordless account. Use your recovery key.")]
    NeedsRecovery,
    #[error("This file is damaged or has been changed.")]
    Tampered,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
}

impl TransferError {
    /// The `AppError` code of the TypeScript core.
    pub fn code(&self) -> &'static str {
        match self {
            Self::OldFormat => "transfer.old_format",
            Self::NotKasboek => "transfer.not_kasboek",
            Self::Corrupt | Self::Tampered => "transfer.corrupt",
            Self::Unsupported => "transfer.unsupported",
            Self::WrongCredentials => "transfer.wrong_credentials",
            Self::NeedsRecovery => "transfer.needs_recovery",
            Self::Crypto(e) => e.code(),
        }
    }
}

/// Encodes with a random salt and IV.
pub fn encode_transfer(input: &TransferInput<'_>) -> Result<Vec<u8>, TransferError> {
    encode_transfer_with(input, random_bytes::<16>(), random_bytes::<12>())
}

/// `encode_transfer` with a chosen salt and IV, for known-answer tests only.
pub fn encode_transfer_with(input: &TransferInput<'_>, salt: [u8; 16], iv: [u8; 12]) -> Result<Vec<u8>, TransferError> {
    use crate::encoding::base64_encode;
    let header = TransferHeader {
        format: 2,
        kind: input.kind,
        created_at: input.created_at.clone(),
        app_version: input.app_version.clone(),
        schema_version: input.schema_version,
        mode: input.mode,
        two_factor: input.two_factor,
        slots: TransferSlots { recovery: input.recovery_slot.clone(), password: input.password_slot.clone() },
        salt: base64_encode(&salt),
        iv: base64_encode(&iv),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|_| TransferError::Corrupt)?;
    let mut file = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len() + input.db_file.len() + 1024);
    file.extend_from_slice(MAGIC);
    file.extend_from_slice(&u32::try_from(header_bytes.len()).map_err(|_| TransferError::Corrupt)?.to_be_bytes());
    file.extend_from_slice(&header_bytes);
    let aad_len = file.len();

    let vault_bytes = Zeroizing::new(serde_json::to_vec(input.vault).map_err(|_| TransferError::Corrupt)?);
    let mut plain = Zeroizing::new(Vec::with_capacity(4 + vault_bytes.len() + input.db_file.len()));
    plain.extend_from_slice(&u32::try_from(vault_bytes.len()).map_err(|_| TransferError::Corrupt)?.to_be_bytes());
    plain.extend_from_slice(&vault_bytes);
    plain.extend_from_slice(input.db_file);

    let key = hkdf(input.master, &salt, FILE_INFO);
    let sealed = Aes256Gcm::new((&*key).into())
        .encrypt(Nonce::from_slice(&iv), Payload { msg: &plain, aad: &file[..aad_len] })
        .map_err(|_| TransferError::Corrupt)?;
    file.extend_from_slice(&sealed);
    Ok(file)
}

struct Parts<'a> {
    header: TransferHeader,
    aad: &'a [u8],
    /// Ciphertext followed by the tag, as AES-GCM wants it.
    sealed: &'a [u8],
}

fn split(file: &[u8]) -> Result<Parts<'_>, TransferError> {
    if file.len() < MAGIC.len() + 4 || file[..MAGIC.len()].ct_eq(MAGIC).unwrap_u8() == 0 {
        return Err(if file.starts_with(b"KASBOEK1") { TransferError::OldFormat } else { TransferError::NotKasboek });
    }
    let header_len = u32::from_be_bytes(file[MAGIC.len()..MAGIC.len() + 4].try_into().expect("4 bytes")) as usize;
    let end = MAGIC.len() + 4 + header_len;
    if header_len == 0 || header_len > MAX_HEADER || file.len() < end + TAG_LEN {
        return Err(TransferError::Corrupt);
    }
    let value: serde_json::Value = serde_json::from_slice(&file[MAGIC.len() + 4..end]).map_err(|_| TransferError::Corrupt)?;
    if value.get("format") != Some(&serde_json::Value::from(2)) {
        return Err(TransferError::Unsupported);
    }
    let header = serde_json::from_value(value).map_err(|_| TransferError::Corrupt)?;
    Ok(Parts { header, aad: &file[..end], sealed: &file[end..] })
}

/// The readable header only. Trust it only after `open_transfer` succeeds.
pub fn read_transfer_header(file: &[u8]) -> Result<TransferHeader, TransferError> {
    Ok(split(file)?.header)
}

/// Opens an export with the password (and 2FA code if the account uses 2FA) or with the recovery key.
/// `now` is unix seconds, used for the 2FA check. Errors don't say which part was wrong.
pub fn open_transfer(file: &[u8], credential: &Credential<'_>, now: f64) -> Result<TransferContents, TransferError> {
    let Parts { header, aad, sealed } = split(file)?;
    let (master, used_recovery) = match credential {
        Credential::RecoveryKey(key) => (open_slot(&header.slots.recovery, &normalize_recovery_key(key), SlotKind::Recovery)?, true),
        Credential::Password { password, .. } => match &header.slots.password {
            Some(slot) => (open_slot(slot, password, SlotKind::Password)?, false),
            None => return Err(TransferError::NeedsRecovery),
        },
    };
    let master = master.ok_or(TransferError::WrongCredentials)?;

    let salt = base64_decode(&header.salt).ok_or(TransferError::Tampered)?;
    let iv = base64_decode(&header.iv).ok_or(TransferError::Tampered)?;
    if iv.len() != 12 {
        return Err(TransferError::Tampered);
    }
    let key = hkdf(&*master, &salt, FILE_INFO);
    let plain = Aes256Gcm::new((&*key).into())
        .decrypt(Nonce::from_slice(&iv), Payload { msg: sealed, aad })
        .map(Zeroizing::new)
        .map_err(|_| TransferError::Tampered)?;
    if plain.len() < 4 {
        return Err(TransferError::Corrupt);
    }
    let vault_len = u32::from_be_bytes(plain[..4].try_into().expect("4 bytes")) as usize;
    let vault_bytes = plain.get(4..4 + vault_len).ok_or(TransferError::Corrupt)?;
    let mut vault: Vault = serde_json::from_slice(vault_bytes).map_err(|_| TransferError::Corrupt)?;
    let db_file = plain[4 + vault_len..].to_vec();

    if !used_recovery && header.two_factor {
        let code = match credential {
            Credential::Password { code, .. } => *code,
            Credential::RecoveryKey(_) => None,
        };
        let step = match (&vault.totp, code) {
            (Some(totp), Some(code)) => verify_totp(&totp.secret, code, -1, now)?,
            _ => None,
        };
        let step = step.ok_or(TransferError::WrongCredentials)?;
        if let Some(totp) = vault.totp.as_mut() {
            totp.last_step = step;
        }
    }
    Ok(TransferContents { header, master, vault, db_file, used_recovery })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slot::{make_slot_with, Argon2Cost};

    const CHEAP: Argon2Cost = Argon2Cost { m: 64, t: 1, p: 1 };
    const MASTER: [u8; 32] = [0x42; 32];

    fn sample(two_factor: bool, db: &[u8]) -> (Vec<u8>, String) {
        let recovery = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723";
        let vault: Vault =
            serde_json::from_str(r#"{"dbKey":"aa","totp":{"secret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","lastStep":-1}}"#).unwrap();
        let input = TransferInput {
            kind: TransferKind::Export,
            created_at: "2026-01-02T03:04:05.678Z".into(),
            app_version: "0.0.0".into(),
            schema_version: 15,
            mode: AuthMode::Password,
            two_factor,
            password_slot: Some(make_slot_with(&MASTER, "invented pass", SlotKind::Password, CHEAP).unwrap()),
            recovery_slot: make_slot_with(&MASTER, recovery, SlotKind::Recovery, CHEAP).unwrap(),
            master: &MASTER,
            vault: &vault,
            db_file: db,
        };
        (encode_transfer(&input).unwrap(), recovery.to_string())
    }

    #[test]
    fn roundtrip_with_password_and_recovery_key() {
        let (file, recovery) = sample(false, b"database bytes");
        let by_password = open_transfer(&file, &Credential::Password { password: "invented pass", code: None }, 0.0).unwrap();
        assert_eq!(by_password.db_file, b"database bytes");
        assert!(!by_password.used_recovery);
        assert_eq!(*by_password.master, MASTER);
        let by_recovery = open_transfer(&file, &Credential::RecoveryKey(&recovery.to_lowercase()), 0.0).unwrap();
        assert!(by_recovery.used_recovery);
        assert_eq!(by_recovery.vault, by_password.vault);
        assert_eq!(by_password.header.created_at, "2026-01-02T03:04:05.678Z");
    }

    #[test]
    fn debug_and_errors_hide_secrets() {
        let (file, recovery) = sample(false, b"database bytes");
        let password = "invented pass";
        let secrets = [password, recovery.as_str(), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "database bytes"];
        let contents = open_transfer(&file, &Credential::Password { password, code: Some("123456") }, 0.0).unwrap();
        let credentials = [Credential::Password { password, code: Some("123456") }, Credential::RecoveryKey(&recovery)];
        let mut texts = vec![format!("{contents:?}"), format!("{:#?}", contents)];
        texts.extend(credentials.iter().map(|c| format!("{c:?}")));
        texts.push(format!(
            "{:?}",
            TransferInput {
                kind: TransferKind::Export,
                created_at: String::new(),
                app_version: String::new(),
                schema_version: 1,
                mode: AuthMode::Password,
                two_factor: false,
                password_slot: None,
                recovery_slot: contents.header.slots.recovery.clone(),
                master: &MASTER,
                vault: &contents.vault,
                db_file: b"database bytes",
            }
        ));
        let wrong = open_transfer(&file, &Credential::Password { password: "nope-secret", code: None }, 0.0).unwrap_err();
        let bad = open_transfer(&file, &Credential::RecoveryKey("QQQQ-secret"), 0.0).unwrap_err();
        for e in [wrong, bad] {
            texts.push(format!("{e} {e:?}"));
        }
        for text in &texts {
            for secret in secrets.iter().chain(&["nope-secret", "QQQQ-secret"]) {
                assert!(!text.contains(secret), "{text}");
            }
        }
    }

    #[test]
    fn wrong_credentials_and_tampering_are_refused() {
        let (file, _) = sample(false, b"db");
        let wrong = open_transfer(&file, &Credential::Password { password: "nope", code: None }, 0.0);
        assert_eq!(wrong.err(), Some(TransferError::WrongCredentials));
        let mut changed = file.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        let tampered = open_transfer(&changed, &Credential::Password { password: "invented pass", code: None }, 0.0);
        assert_eq!(tampered.err(), Some(TransferError::Tampered));
        let mut header_changed = file.clone();
        header_changed[8 + 4 + 12] ^= 0x01; // inside the header JSON: the AAD no longer matches (or the JSON is damaged)
        assert!(open_transfer(&header_changed, &Credential::RecoveryKey("x"), 0.0).is_err());
    }

    #[test]
    fn two_factor_needs_a_current_code_but_the_recovery_key_skips_it() {
        let (file, recovery) = sample(true, b"db");
        let pw = |code| Credential::Password { password: "invented pass", code };
        assert_eq!(open_transfer(&file, &pw(None), 59.0).err(), Some(TransferError::WrongCredentials));
        assert_eq!(open_transfer(&file, &pw(Some("000000")), 59.0).err(), Some(TransferError::WrongCredentials));
        let opened = open_transfer(&file, &pw(Some("287082")), 59.0).unwrap();
        assert_eq!(opened.vault.totp.unwrap().last_step, 1);
        assert!(open_transfer(&file, &Credential::RecoveryKey(&recovery), 0.0).is_ok());
    }

    #[test]
    fn header_limits_and_magic() {
        assert_eq!(read_transfer_header(b"KASBOEK1\0\0\0\0").err(), Some(TransferError::OldFormat));
        assert_eq!(read_transfer_header(b"hello world, not a file").err(), Some(TransferError::NotKasboek));
        let mut zero = b"KASBOEK2".to_vec();
        zero.extend_from_slice(&[0, 0, 0, 0]);
        zero.extend_from_slice(&[0u8; 32]);
        assert_eq!(read_transfer_header(&zero).err(), Some(TransferError::Corrupt));
        let mut big = b"KASBOEK2".to_vec();
        big.extend_from_slice(&(64u32 * 1024 + 1).to_be_bytes());
        big.extend(std::iter::repeat_n(b' ', 64 * 1024 + 1 + 16));
        assert_eq!(read_transfer_header(&big).err(), Some(TransferError::Corrupt));
        let mut newer = b"KASBOEK2".to_vec();
        let json = br#"{"format":3}"#;
        newer.extend_from_slice(&(json.len() as u32).to_be_bytes());
        newer.extend_from_slice(json);
        newer.extend_from_slice(&[0u8; 16]);
        assert_eq!(read_transfer_header(&newer).err(), Some(TransferError::Unsupported));
    }

    #[test]
    fn passwordless_exports_need_the_recovery_key() {
        let vault: Vault = serde_json::from_str(r#"{"dbKey":"aa"}"#).unwrap();
        let input = TransferInput {
            kind: TransferKind::Backup,
            created_at: "2026-01-02T03:04:05.678Z".into(),
            app_version: "0.0.0".into(),
            schema_version: 15,
            mode: AuthMode::Device,
            two_factor: false,
            password_slot: None,
            recovery_slot: make_slot_with(&MASTER, "ABCD", SlotKind::Recovery, CHEAP).unwrap(),
            master: &MASTER,
            vault: &vault,
            db_file: b"x",
        };
        let file = encode_transfer(&input).unwrap();
        assert_eq!(
            open_transfer(&file, &Credential::Password { password: "a", code: None }, 0.0).err(),
            Some(TransferError::NeedsRecovery)
        );
        assert!(open_transfer(&file, &Credential::RecoveryKey("abcd"), 0.0).is_ok());
    }
}
