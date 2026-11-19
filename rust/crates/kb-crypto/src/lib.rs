//! Kasboek crypto, a byte-compatible port of src/core/{crypto,totp,account,transfer-format,sync-file}.ts.
//!
//! - [`aead`]: AES-256-GCM with a label as associated data, HKDF-SHA256.
//! - [`slot`]: key slots (password Argon2id, legacy scrypt, recovery HKDF); [`recovery`]: the recovery key format.
//! - [`vault`]: the vault seal. [`totp`]: RFC 6238 codes. [`encoding`]: base32, base64, hex.
//! - [`transfer`]: the `.kasboek` export file (KASBOEK2). [`syncfile`]: the `.kbsync` file (KBSYNC1).
//!
//! Keys live in `Zeroizing` buffers. No I/O and no clock: callers pass times in. Errors are typed and carry the
//! `AppError` code the TypeScript core uses.
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use zeroize::Zeroizing;

pub mod aead;
pub mod encoding;
pub mod error;
pub mod recovery;
pub mod slot;
pub mod syncfile;
pub mod totp;
pub mod transfer;
pub mod vault;

pub use error::CryptoError;

/// A derived 32-byte key.
pub type Key = Zeroizing<[u8; 32]>;
/// The master key a slot wraps.
pub type Master = Zeroizing<[u8; 32]>;

/// Random bytes from the operating system. Panics if it has none (nothing safe can be done then).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.try_fill_bytes(&mut out).expect("the operating system provides random bytes");
    out
}
