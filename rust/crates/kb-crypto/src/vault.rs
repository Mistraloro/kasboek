//! The vault: `{dbKey, totp?}` sealed with the master key and the label `kasboek:vault` (src/core/account.ts).
use crate::aead::{seal, unseal, Sealed};
use crate::error::CryptoError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
use zeroize::Zeroizing;

const VAULT_LABEL: &str = "kasboek:vault";

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct Totp {
    pub secret: Zeroizing<String>,
    /// The last accepted time step (-1 before any).
    #[serde(rename = "lastStep")]
    pub last_step: i64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct Vault {
    /// Database encryption key, hex.
    #[serde(rename = "dbKey")]
    pub db_key: Zeroizing<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totp: Option<Totp>,
    /// Fields written by a newer version, kept so a re-seal does not drop them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Debug output never shows secrets: the TOTP secret is redacted, only the non-secret step is shown.
impl fmt::Debug for Totp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Totp").field("secret", &"<redacted>").field("last_step", &self.last_step).finish()
    }
}

/// Debug output never shows secrets: the key and TOTP are redacted, unknown fields are listed by name only.
impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("db_key", &"<redacted>")
            .field("totp", &self.totp.as_ref().map(|_| "<redacted>"))
            .field("extra", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

pub fn seal_vault(master: &[u8; 32], vault: &Vault) -> Sealed {
    let json = Zeroizing::new(serde_json::to_vec(vault).expect("a vault always serialises"));
    seal(master, &json, VAULT_LABEL)
}

pub fn open_vault(master: &[u8; 32], sealed: &Sealed) -> Result<Vault, CryptoError> {
    let plain = unseal(master, sealed, VAULT_LABEL).ok_or(CryptoError::Corrupt)?;
    serde_json::from_slice(&plain).map_err(|_| CryptoError::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_roundtrip_keeps_unknown_fields_and_binds_the_key() {
        let master = [5u8; 32];
        let vault: Vault = serde_json::from_str(r#"{"dbKey":"00ff","totp":{"secret":"ABC","lastStep":-1},"future":{"x":1}}"#).unwrap();
        let sealed = seal_vault(&master, &vault);
        assert_eq!(open_vault(&master, &sealed).unwrap(), vault);
        assert_eq!(serde_json::to_string(&vault).unwrap(), r#"{"dbKey":"00ff","totp":{"secret":"ABC","lastStep":-1},"future":{"x":1}}"#);
        assert_eq!(open_vault(&[6u8; 32], &sealed).unwrap_err(), CryptoError::Corrupt);
    }

    #[test]
    fn debug_output_hides_secrets() {
        let vault: Vault =
            serde_json::from_str(r#"{"dbKey":"KEY-SECRET-1","totp":{"secret":"TOTP-SECRET-2","lastStep":7},"future":"EXTRA-SECRET-3"}"#)
                .unwrap();
        for text in [format!("{vault:?}"), format!("{vault:#?}"), format!("{:?}", vault.totp)] {
            for secret in ["KEY-SECRET-1", "TOTP-SECRET-2", "EXTRA-SECRET-3"] {
                assert!(!text.contains(secret), "{text}");
            }
        }
        assert!(format!("{vault:?}").contains("<redacted>"));
        let sealed = seal_vault(&[5u8; 32], &vault);
        let err = open_vault(&[6u8; 32], &sealed).unwrap_err();
        assert!(!format!("{err} {err:?}").contains("KEY-SECRET-1"));
    }
}
