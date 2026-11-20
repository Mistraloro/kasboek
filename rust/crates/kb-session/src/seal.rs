//! The operating system seal around account.json. Real DPAPI, Keychain and Secret Service implementations live in
//! `kb-oseal` (which depends on this crate, not the other way round); this crate has the trait, a test implementation
//! and an "unsupported" one.
//!
//! The `seal` value of account.json names who sealed the file, see [`SEAL_NONE`], [`SEAL_OS`] and [`SEAL_OS_NATIVE`].
use crate::oscrypt::SealError;
use kb_crypto::aead::{seal, unseal, Sealed};
use kb_crypto::encoding::{base64_decode, base64_encode};
use zeroize::Zeroizing;

/// `seal` value: `data` is the plain account JSON (password accounts only).
pub const SEAL_NONE: &str = "none";
/// `seal` value: sealed by Electron's `safeStorage` (and by the test `FileSeal`, which stands in for it). A native
/// build cannot open a real Electron value except through `kb-oseal`'s migration.
pub const SEAL_OS: &str = "os";
/// `seal` value: sealed by the native seal of `kb-oseal` (DPAPI `KBD1`, wrap key `KBK1`).
pub const SEAL_OS_NATIVE: &str = "os-native";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProtection {
    Os,
    Weak,
}

impl KeyProtection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Os => "os",
            Self::Weak => "weak",
        }
    }
}

pub trait OsSeal: Send + Sync {
    /// `safeStorage.isAsyncEncryptionAvailable()`. When false, account.json is written with `seal: 'none'`.
    fn available(&self) -> bool;
    /// True for a backend that gives no real protection (the Linux `basic_text` store).
    fn weak(&self) -> bool {
        false
    }
    /// The `seal` value written to account.json for what this seal makes ([`SEAL_OS`] unless it is a native seal).
    fn seal_value(&self) -> &'static str {
        SEAL_OS
    }
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError>;
    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError>;

    fn protection(&self) -> KeyProtection {
        if self.available() && !self.weak() {
            KeyProtection::Os
        } else {
            KeyProtection::Weak
        }
    }
}

/// No operating system seal: account.json is written as `seal: 'none'` and `seal: 'os'` files cannot be opened.
pub struct Unsupported;

impl OsSeal for Unsupported {
    fn available(&self) -> bool {
        false
    }

    fn seal(&self, _plain: &[u8]) -> Result<Vec<u8>, SealError> {
        Err(SealError::Unavailable)
    }

    fn unseal(&self, _sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        Err(SealError::Unavailable)
    }
}

const FILE_SEAL_LABEL: &str = "kasboek:fileseal";

/// A seal with a key held by the test: AES-256-GCM, blob = `iv(12) || ciphertext || tag(16)`, AAD `kasboek:fileseal`.
/// The parity tests give the TypeScript `safeStorage` mock the same scheme, so files cross-open. Not for real use.
pub struct FileSeal {
    key: Zeroizing<[u8; 32]>,
    weak: bool,
}

impl FileSeal {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key: Zeroizing::new(key), weak: false }
    }

    /// Like a Linux `basic_text` backend: works, but `keyProtection` says `weak`.
    pub fn weak(key: [u8; 32]) -> Self {
        Self { key: Zeroizing::new(key), weak: true }
    }
}

impl OsSeal for FileSeal {
    fn available(&self) -> bool {
        true
    }

    fn weak(&self) -> bool {
        self.weak
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let s = seal(&self.key, plain, FILE_SEAL_LABEL);
        let mut out = base64_decode(&s.iv).ok_or(SealError::Failed)?;
        out.extend(base64_decode(&s.ct).ok_or(SealError::Failed)?);
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        if sealed.len() < 12 + 16 {
            return Err(SealError::Failed);
        }
        let s = Sealed { iv: base64_encode(&sealed[..12]), ct: base64_encode(&sealed[12..]) };
        unseal(&self.key, &s, FILE_SEAL_LABEL).ok_or(SealError::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_seal_roundtrips_and_refuses_other_keys() {
        let a = FileSeal::new([1; 32]);
        let blob = a.seal(b"invented").unwrap();
        assert_eq!(a.unseal(&blob).unwrap().as_slice(), b"invented");
        assert_eq!(FileSeal::new([2; 32]).unseal(&blob).unwrap_err(), SealError::Failed);
        assert_eq!(a.unseal(&blob[..20]).unwrap_err(), SealError::Failed);
        assert_eq!(a.protection(), KeyProtection::Os);
        assert_eq!(FileSeal::weak([1; 32]).protection(), KeyProtection::Weak);
        assert_eq!(Unsupported.protection(), KeyProtection::Weak);
    }
}
