//! Reads and writes account.json, sealed by the operating system. The seal binds the data to this computer and user:
//! a copied file can't be opened elsewhere, even with the password. Port of src/main/security/account-store.ts.
//!
//! File: `{"format":"kasboek-account","version":2,"seal":"os"|"os-native"|"none","data":"<base64>"}`; `data` is the
//! OS-sealed (or, for `none`, plain) JSON of the account. `os` and `os-native` are both opened with the configured
//! [`OsSeal`], which refuses a blob it did not make (an Electron `v10`/`v11` value is `auth.other_device` here; the
//! migration in `kb-oseal` turns it into `os-native`). A seal writes the value it reports in [`OsSeal::seal_value`].
use crate::account::AccountData;
use crate::error::{SessionError, SessionResult};
use crate::paths::Paths;
use crate::seal::{KeyProtection, OsSeal, SEAL_NONE, SEAL_OS, SEAL_OS_NATIVE};
use kb_crypto::encoding::{base64_decode, base64_encode};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroizing;

/// Larger files are refused before they are read (a real account is a few KiB).
pub const MAX_ACCOUNT_FILE: u64 = 1024 * 1024;
const MAX_KEYSTORE_FILE: u64 = 64 * 1024;

/// An account.json read from disk but not yet opened: `data` is still sealed.
#[derive(Clone)]
pub struct RawAccountFile {
    pub seal_os: bool,
    /// Sealed bytes for `os`; the plain account (with the master key of a device account) for `none`.
    data: Zeroizing<Vec<u8>>,
}

pub struct AccountStore {
    pub paths: Paths,
    pub seal: Box<dyn OsSeal>,
    /// Set once `seal.available()` has said yes: that answer must not change between two saves (a key that was written
    /// sealed must not be written readable later). A "no" is asked again, so a keyring that appears later is used.
    available: AtomicBool,
}

fn other_device() -> SessionError {
    SessionError::new(
        "auth.other_device",
        "This Kasboek data belongs to another computer or user account and can’t be opened here. Use Export on the old computer and Import here.",
    )
}

/// Reads at most `cap` bytes; one byte more is read to notice a larger file (no size check that could go stale).
fn read_capped(path: &std::path::Path, cap: u64) -> SessionResult<Zeroizing<Vec<u8>>> {
    let io = |e: std::io::Error| SessionError::corrupt(e.to_string());
    let mut bytes = Zeroizing::new(Vec::new());
    fs::File::open(path).map_err(io)?.take(cap + 1).read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() as u64 > cap {
        return Err(SessionError::corrupt("The account file is damaged."));
    }
    Ok(bytes)
}

/// Makes the new file durable: the rename itself is in the directory entry.
fn sync_dir(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| std::path::Path::new("."));
        fs::File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

impl AccountStore {
    pub fn new(paths: Paths, seal: Box<dyn OsSeal>) -> Self {
        Self { paths, seal, available: AtomicBool::new(false) }
    }

    fn seal_available(&self) -> bool {
        if self.available.load(Ordering::Relaxed) {
            return true;
        }
        let yes = self.seal.available();
        self.available.store(yes, Ordering::Relaxed);
        yes
    }

    pub fn key_protection(&self) -> KeyProtection {
        if self.seal_available() && !self.seal.weak() {
            KeyProtection::Os
        } else {
            KeyProtection::Weak
        }
    }

    pub fn exists(&self) -> bool {
        self.paths.account_file.exists()
    }

    /// Reads and checks the file but does not unseal it: for device-mode accounts nothing may be opened before the
    /// person has been verified (docs/rust-port-plan.md section 5).
    pub fn read_raw(&self) -> SessionResult<Option<RawAccountFile>> {
        if !self.exists() {
            return Ok(None);
        }
        let bytes = read_capped(&self.paths.account_file, MAX_ACCOUNT_FILE)?;
        let mut file: Value = serde_json::from_slice(&bytes).map_err(|e| SessionError::corrupt(e.to_string()))?;
        if file.get("format").and_then(Value::as_str) != Some("kasboek-account") {
            return Err(SessionError::corrupt("The account file is damaged."));
        }
        // Moved out of the parsed value, so the only copy of a plain (`none`) account text is one that is wiped.
        let text = match file.get_mut("data").map(Value::take) {
            Some(Value::String(s)) => Zeroizing::new(s),
            _ => Zeroizing::new(String::new()),
        };
        let data = Zeroizing::new(base64_decode(&text).unwrap_or_default());
        let seal = file.get("seal").and_then(Value::as_str);
        Ok(Some(RawAccountFile { seal_os: matches!(seal, Some(SEAL_OS | SEAL_OS_NATIVE)), data }))
    }

    /// Opens a raw file: with the OS seal for `os`, as plain text for `none`.
    pub fn open_raw(&self, raw: &RawAccountFile) -> SessionResult<AccountData> {
        let json: Zeroizing<Vec<u8>> = if raw.seal_os {
            // Typical when the data folder was copied from another computer or user account.
            self.seal.unseal(&raw.data).map_err(|_| other_device())?
        } else {
            Zeroizing::new(raw.data.to_vec())
        };
        serde_json::from_slice(&json).map_err(|_| {
            SessionError::new(
                "auth.other_device",
                "This Kasboek data can’t be opened here. It may come from another computer or user account: use Export on the old computer and Import here.",
            )
        })
    }

    pub fn load(&self) -> SessionResult<Option<AccountData>> {
        self.read_raw()?.map(|raw| self.open_raw(&raw)).transpose()
    }

    /// Writes through a temporary file and a rename, so a crash never leaves half an account.
    pub fn save(&self, account: &AccountData) -> SessionResult<()> {
        let os = self.seal_available();
        if !os && account.slots.device.is_some() {
            // Without the seal the master key of a passwordless account would be written as readable text.
            return Err(SessionError::new(
                "auth.device_unprotected",
                "Kasboek’s key can’t be protected on this computer right now, so the account was not saved.",
            ));
        }
        let json = Zeroizing::new(serde_json::to_vec(account).map_err(|_| SessionError::failed())?);
        let data = Zeroizing::new(if os {
            base64_encode(&self.seal.seal(&json).map_err(|_| SessionError::failed())?)
        } else {
            base64_encode(&json)
        });
        // Base64 needs no escaping, so the text is built directly: no parsed copy of a plain account is left behind.
        let file = Zeroizing::new(format!(
            r#"{{"format":"kasboek-account","version":2,"seal":"{}","data":"{}"}}"#,
            if os { self.seal.seal_value() } else { SEAL_NONE },
            *data
        ));
        let mut tmp = self.paths.account_file.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = std::path::PathBuf::from(tmp);
        let write = || -> std::io::Result<()> {
            // A leftover (or planted) temporary file is removed, never opened: `create_new` refuses to follow it.
            match fs::remove_file(&tmp) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut f = options.open(&tmp)?;
            #[cfg(unix)]
            f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            f.write_all(file.as_bytes())?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, &self.paths.account_file)?;
            sync_dir(&self.paths.account_file)
        };
        write().map_err(|_| {
            let _ = fs::remove_file(&tmp);
            SessionError::failed()
        })
    }

    /// Phase 1 stored the database key in keystore.json. Returns it so setup can keep the existing data.
    pub fn read_legacy_db_key(&self) -> Option<Zeroizing<String>> {
        if !self.paths.legacy_keystore_file.exists() || !self.paths.db_file.exists() {
            return None;
        }
        let bytes = read_capped(&self.paths.legacy_keystore_file, MAX_KEYSTORE_FILE).ok()?;
        let data: Value = serde_json::from_slice(&bytes).ok()?;
        let v = data.get("dbKey").and_then(Value::as_str).unwrap_or("");
        let plain = if let Some(rest) = v.strip_prefix("os:") {
            self.seal.unseal(&base64_decode(rest)?).ok()?
        } else {
            Zeroizing::new(base64_decode(v.strip_prefix("plain:")?)?)
        };
        std::str::from_utf8(&plain).ok().map(|t| Zeroizing::new(t.to_owned()))
    }

    /// Removes `account.electron.json` (what the migration kept). Called once the native seal has been used for a
    /// successful unlock and save, and after every credential change. A missing file is fine.
    pub fn remove_electron_backup(&self) -> std::io::Result<()> {
        match fs::remove_file(&self.paths.electron_backup_file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn remove_legacy_keystore(&self) {
        let _ = fs::remove_file(&self.paths.legacy_keystore_file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{create_account, AuthMode, Crypto};
    use crate::seal::{FileSeal, Unsupported};
    use crate::time::{ManualClock, SeededRng};
    use kb_crypto::slot::Argon2Cost;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn account(mode: AuthMode) -> AccountData {
        let (clock, rng) = (ManualClock::new(1_790_000_000_000), SeededRng::new(3));
        let c = Crypto { clock: &clock, rng: &rng, cost: Argon2Cost { m: 64, t: 1, p: 1 } };
        create_account(&c, mode, (mode == AuthMode::Password).then_some("violet-Harbor-83-lantern"), &"ab".repeat(32)).unwrap().account
    }

    /// A seal whose availability can be switched, like a keyring that gets locked.
    struct Flaky(Arc<AtomicBool>, FileSeal);

    impl OsSeal for Flaky {
        fn available(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, crate::oscrypt::SealError> {
            self.1.seal(plain)
        }
        fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, crate::oscrypt::SealError> {
            self.1.unseal(sealed)
        }
    }

    #[test]
    fn a_device_account_is_never_written_without_the_seal() {
        let dir = tempfile::tempdir().unwrap();
        let store = AccountStore::new(Paths::in_dir(dir.path()), Box::new(Unsupported));
        assert_eq!(store.save(&account(AuthMode::Device)).unwrap_err().code, "auth.device_unprotected");
        assert!(!store.exists() && !dir.path().join("account.json.tmp").exists());
        // A password account has no key in clear: it may be written as `none`.
        store.save(&account(AuthMode::Password)).unwrap();
        assert!(store.exists());
    }

    #[test]
    fn availability_is_asked_once_so_a_flip_cannot_leak_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        let store = AccountStore::new(Paths::in_dir(dir.path()), Box::new(Flaky(flag.clone(), FileSeal::new([1; 32]))));
        store.save(&account(AuthMode::Device)).unwrap();
        flag.store(false, Ordering::SeqCst);
        store.save(&account(AuthMode::Device)).unwrap();
        let text = std::fs::read_to_string(dir.path().join("account.json")).unwrap();
        assert!(text.contains(r#""seal":"os""#));
        assert_eq!(store.key_protection(), KeyProtection::Os);
    }

    #[test]
    fn a_leftover_temporary_file_is_replaced_and_the_account_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let store = AccountStore::new(Paths::in_dir(dir.path()), Box::new(FileSeal::new([1; 32])));
        std::fs::write(dir.path().join("account.json.tmp"), b"left behind").unwrap();
        store.save(&account(AuthMode::Password)).unwrap();
        assert!(!dir.path().join("account.json.tmp").exists());
        assert!(store.load().unwrap().is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&store.paths.account_file).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    /// A seal that reports itself as a native one.
    struct Native(FileSeal);

    impl OsSeal for Native {
        fn available(&self) -> bool {
            true
        }
        fn seal_value(&self) -> &'static str {
            SEAL_OS_NATIVE
        }
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, crate::oscrypt::SealError> {
            self.0.seal(plain)
        }
        fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, crate::oscrypt::SealError> {
            self.0.unseal(sealed)
        }
    }

    #[test]
    fn a_native_seal_writes_os_native_and_both_os_values_open_through_the_seal() {
        let dir = tempfile::tempdir().unwrap();
        let store = AccountStore::new(Paths::in_dir(dir.path()), Box::new(Native(FileSeal::new([1; 32]))));
        store.save(&account(AuthMode::Device)).unwrap();
        let text = std::fs::read_to_string(dir.path().join("account.json")).unwrap();
        assert!(text.contains(r#""seal":"os-native""#));
        assert!(store.read_raw().unwrap().unwrap().seal_os);
        assert!(store.load().unwrap().is_some());
        // The test seal (value `os`) writes what the TypeScript app writes.
        let plain_os = AccountStore::new(Paths::in_dir(dir.path()), Box::new(FileSeal::new([1; 32])));
        plain_os.save(&account(AuthMode::Device)).unwrap();
        assert!(std::fs::read_to_string(dir.path().join("account.json")).unwrap().contains(r#""seal":"os","#));
        assert!(store.load().unwrap().is_some());
    }

    #[test]
    fn without_a_seal_an_os_native_file_is_another_device_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        AccountStore::new(Paths::in_dir(dir.path()), Box::new(Native(FileSeal::new([1; 32])))).save(&account(AuthMode::Device)).unwrap();
        let none = AccountStore::new(Paths::in_dir(dir.path()), Box::new(Unsupported));
        assert_eq!(none.load().err().unwrap().code, "auth.other_device");
    }

    #[test]
    fn an_unavailable_answer_is_asked_again_so_a_keyring_that_appears_later_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let store = AccountStore::new(Paths::in_dir(dir.path()), Box::new(Flaky(flag.clone(), FileSeal::new([1; 32]))));
        assert_eq!(store.key_protection(), KeyProtection::Weak);
        flag.store(true, Ordering::SeqCst);
        assert_eq!(store.key_protection(), KeyProtection::Os);
    }

    #[test]
    fn the_size_cap_applies_to_what_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big");
        std::fs::write(&path, vec![b'x'; 11]).unwrap();
        assert_eq!(read_capped(&path, 10).unwrap_err().code, "auth.corrupt");
        assert_eq!(read_capped(&path, 11).unwrap().len(), 11);
    }
}
