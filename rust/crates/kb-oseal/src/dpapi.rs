//! Windows DPAPI seal (`CryptProtectData` / `CryptUnprotectData`, current-user scope, no UI).
//!
//! Blob: `"KBD1" || DPAPI blob`, protected with the fixed optional entropy [`ENTROPY`]. The entropy only keeps another
//! program of the same user from replaying the blob into `CryptUnprotectData` without knowing it; it is not a secret.
//! DPAPI works without a loaded user profile on CI runners and needs no prompt. The calls are behind [`DpapiApi`] so
//! the logic is tested on any OS; [`SystemDpapi`] is the real one (Windows only).
use crate::error::OsealError;
use kb_session::oscrypt::{Dpapi, SealError};
use kb_session::seal::{OsSeal, SEAL_OS_NATIVE};
use zeroize::Zeroizing;

pub const DPAPI_MAGIC: &[u8; 4] = b"KBD1";
pub const ENTROPY: &[u8] = b"kasboek:oseal:dpapi:v1";

pub trait DpapiApi: Send + Sync {
    fn protect(&self, plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, OsealError>;
    fn unprotect(&self, blob: &[u8], entropy: Option<&[u8]>) -> Result<Zeroizing<Vec<u8>>, OsealError>;
}

pub struct DpapiSeal<D: DpapiApi> {
    api: D,
}

impl<D: DpapiApi> DpapiSeal<D> {
    pub fn new(api: D) -> Self {
        Self { api }
    }
}

impl<D: DpapiApi> OsSeal for DpapiSeal<D> {
    fn available(&self) -> bool {
        true
    }

    fn seal_value(&self) -> &'static str {
        SEAL_OS_NATIVE
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        let mut out = DPAPI_MAGIC.to_vec();
        out.extend(self.api.protect(plain, Some(ENTROPY))?);
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let blob = sealed.strip_prefix(DPAPI_MAGIC).ok_or(SealError::Unsupported)?;
        Ok(self.api.unprotect(blob, Some(ENTROPY))?)
    }
}

/// What kb-session's `Local State` reader needs: unprotect without entropy (Chromium protects its key without).
pub struct ChromiumDpapi<'a>(pub &'a dyn DpapiApi);

impl Dpapi for ChromiumDpapi<'_> {
    fn unprotect(&self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        Ok(self.0.unprotect(blob, None)?)
    }
}

#[cfg(windows)]
pub use system::SystemDpapi;

#[cfg(windows)]
mod system {
    use super::*;
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// The real DPAPI, user scope.
    #[derive(Default)]
    pub struct SystemDpapi;

    fn blob_of(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, OsealError> {
        Ok(CRYPT_INTEGER_BLOB { cbData: u32::try_from(bytes.len()).map_err(|_| OsealError::Failed)?, pbData: bytes.as_ptr() as *mut u8 })
    }

    /// Copies the output and frees the system buffer, zeroing it first.
    fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        // SAFETY: on success DPAPI returns `cbData` readable bytes in a LocalAlloc buffer that we own and free once.
        unsafe {
            let slice = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
            let copy = Zeroizing::new(slice.to_vec());
            slice.fill(0);
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut c_void)));
            copy
        }
    }

    impl DpapiApi for SystemDpapi {
        fn protect(&self, plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, OsealError> {
            let input = blob_of(plain)?;
            let entropy = entropy.map(blob_of).transpose()?;
            let mut out = CRYPT_INTEGER_BLOB::default();
            // SAFETY: the blobs point at slices that outlive the call; `out` is filled by the system.
            unsafe {
                CryptProtectData(
                    &input,
                    PCWSTR::null(),
                    entropy.as_ref().map(|e| e as *const _),
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out,
                )
            }
            .map_err(|_| OsealError::Failed)?;
            Ok(take(out).to_vec())
        }

        fn unprotect(&self, blob: &[u8], entropy: Option<&[u8]>) -> Result<Zeroizing<Vec<u8>>, OsealError> {
            let input = blob_of(blob)?;
            let entropy = entropy.map(blob_of).transpose()?;
            let mut out = CRYPT_INTEGER_BLOB::default();
            // SAFETY: as in `protect`.
            unsafe {
                CryptUnprotectData(&input, None, entropy.as_ref().map(|e| e as *const _), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
            .map_err(|_| OsealError::Failed)?;
            Ok(take(out))
        }
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;

    /// Stands in for DPAPI: reverses the bytes and appends a tag of the entropy, so a wrong entropy is refused.
    pub struct ReverseDpapi;

    fn tag(entropy: Option<&[u8]>) -> Vec<u8> {
        entropy.map(|e| e.iter().map(|b| b ^ 0x5a).collect()).unwrap_or_default()
    }

    impl DpapiApi for ReverseDpapi {
        fn protect(&self, plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, OsealError> {
            let mut out: Vec<u8> = plain.iter().rev().copied().collect();
            out.extend(tag(entropy));
            Ok(out)
        }
        fn unprotect(&self, blob: &[u8], entropy: Option<&[u8]>) -> Result<Zeroizing<Vec<u8>>, OsealError> {
            let t = tag(entropy);
            let body = blob.strip_suffix(t.as_slice()).ok_or(OsealError::Failed)?;
            Ok(Zeroizing::new(body.iter().rev().copied().collect()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::ReverseDpapi;
    use super::*;
    use kb_session::seal::KeyProtection;

    #[test]
    fn roundtrips_with_the_prefix_and_the_entropy() {
        let seal = DpapiSeal::new(ReverseDpapi);
        let blob = seal.seal(b"invented account").unwrap();
        assert_eq!(&blob[..4], DPAPI_MAGIC);
        assert_eq!(seal.unseal(&blob).unwrap().as_slice(), b"invented account");
        assert_eq!(seal.protection(), KeyProtection::Os);
        assert_eq!(seal.seal_value(), "os-native");
        // The entropy is part of the contract: a blob made without it is refused.
        let mut plain_made = DPAPI_MAGIC.to_vec();
        plain_made.extend(ReverseDpapi.protect(b"x", None).unwrap());
        assert_eq!(seal.unseal(&plain_made).unwrap_err(), SealError::Failed);
    }

    #[test]
    fn refuses_other_formats() {
        let seal = DpapiSeal::new(ReverseDpapi);
        assert_eq!(seal.unseal(b"v10....").unwrap_err(), SealError::Unsupported);
        assert_eq!(seal.unseal(b"").unwrap_err(), SealError::Unsupported);
    }

    #[test]
    fn chromium_adapter_unprotects_without_entropy() {
        let blob = ReverseDpapi.protect(b"key", None).unwrap();
        assert_eq!(ChromiumDpapi(&ReverseDpapi).unprotect(&blob).unwrap().as_slice(), b"key");
    }
}
