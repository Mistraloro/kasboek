//! Errors of the crypto primitives. `code()` gives the `AppError` code the TypeScript core uses for the same case.
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoError {
    /// KDF settings above the caps (a crafted file must not make the app hang or run out of memory).
    #[error("These key settings are not supported.")]
    Unsupported,
    #[error("Invalid character in key.")]
    Base32,
    /// A sealed value that must open (the vault) does not.
    #[error("The account data is damaged.")]
    Corrupt,
    #[error("A key derivation step failed: {0}")]
    Kdf(String),
}

impl CryptoError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "crypto.unsupported",
            Self::Base32 => "crypto.base32",
            Self::Corrupt => "auth.corrupt",
            Self::Kdf(_) => "crypto.kdf",
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::slot::{derive_slot_key, Kdf};

    #[test]
    fn errors_do_not_echo_the_secret() {
        let secret = "hunter1!secret";
        let kdf = Kdf::Argon2id { m: u64::MAX, t: 1, p: 1, salt: "!!".into() };
        let errors = [derive_slot_key(secret, &kdf).unwrap_err(), crate::encoding::base32_decode(secret).unwrap_err()];
        for e in errors {
            assert!(!format!("{e} {e:?}").contains(secret));
        }
    }
}
