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
