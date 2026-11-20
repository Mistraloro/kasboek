//! Electron's `safeStorage` key material per OS, opening an Electron-written account.json, and the migration that
//! re-seals it with the native seal (plan section 4, "account.json file").
//!
//! The AES layers live in `kb_session::oscrypt`; this module only fetches what the OS holds:
//!
//! | OS | Key material |
//! |---|---|
//! | Windows | `<data>/Local State` `os_crypt.encrypted_key`, DPAPI-unprotected without entropy |
//! | macOS | Keychain password, service `Kasboek Safe Storage`, account `Kasboek` |
//! | Linux | Secret Service item `Kasboek Safe Storage` for `v11`; `v10` needs nothing (fixed `peanuts`) |
//!
//! Migration: the new file is `{"format":"kasboek-account","version":2,"seal":"os-native","data":"<base64>"}` and the
//! untouched original is kept as `account.electron.json` (created once, never overwritten). `kb-session`'s store must
//! learn `seal:'os-native'` before it can read the result.
use crate::dpapi::{ChromiumDpapi, DpapiApi};
use crate::error::OsealError;
use crate::wrap::{Item, SecretStore};
use kb_crypto::encoding::{base64_decode, base64_encode};
use kb_session::oscrypt::{decode, windows_key_from_local_state, OsKeyProvider, Platform, SealError};
use kb_session::seal::{KeyProtection, OsSeal};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, Zeroizing};

pub const ACCOUNT_FILE: &str = "account.json";
pub const BACKUP_FILE: &str = "account.electron.json";
pub const NATIVE_SEAL: &str = "os-native";
const LOCAL_STATE_FILE: &str = "Local State";
const FILE_CAP: u64 = 1 << 20;
const LOCAL_STATE_CAP: u64 = 4 << 20;

/// Windows: the key comes from `Local State` and DPAPI.
pub struct WindowsElectronKeys {
    local_state: PathBuf,
    dpapi: Box<dyn DpapiApi>,
}

impl WindowsElectronKeys {
    pub fn new(data_dir: &Path, dpapi: Box<dyn DpapiApi>) -> Self {
        Self { local_state: data_dir.join(LOCAL_STATE_FILE), dpapi }
    }
}

impl OsKeyProvider for WindowsElectronKeys {
    fn windows_key(&self) -> Result<zeroize::Zeroizing<[u8; 32]>, SealError> {
        let text = read_capped(&self.local_state, LOCAL_STATE_CAP).map_err(|_| SealError::Unavailable)?;
        let text = std::str::from_utf8(&text).map_err(|_| SealError::Failed)?;
        windows_key_from_local_state(text, &ChromiumDpapi(&*self.dpapi))
    }

    fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError> {
        Err(SealError::Unavailable)
    }
}

/// macOS and Linux: the password comes from the Keychain / Secret Service.
pub struct StoreElectronKeys<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> StoreElectronKeys<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
}

impl<S: SecretStore> OsKeyProvider for StoreElectronKeys<S> {
    fn windows_key(&self) -> Result<Zeroizing<[u8; 32]>, SealError> {
        Err(SealError::Unavailable)
    }

    fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError> {
        self.store.get(Item::ElectronPassword)?.ok_or(SealError::Unavailable)
    }
}

/// A platform without Electron key material.
pub struct NoKeys;

impl OsKeyProvider for NoKeys {
    fn windows_key(&self) -> Result<Zeroizing<[u8; 32]>, SealError> {
        Err(SealError::Unavailable)
    }

    fn keychain_password(&self) -> Result<Zeroizing<Vec<u8>>, SealError> {
        Err(SealError::Unavailable)
    }
}

pub fn current_platform() -> Option<Platform> {
    if cfg!(windows) {
        Some(Platform::Windows)
    } else if cfg!(target_os = "macos") {
        Some(Platform::Macos)
    } else if cfg!(target_os = "linux") {
        Some(Platform::Linux)
    } else {
        None
    }
}

/// The key provider of this OS. Nothing is read until a value needs a key (a Linux `v10` value touches no keyring).
pub fn electron_key_provider(data_dir: &Path) -> Box<dyn OsKeyProvider> {
    #[cfg(windows)]
    return Box::new(WindowsElectronKeys::new(data_dir, Box::new(crate::dpapi::SystemDpapi)));
    #[cfg(target_os = "macos")]
    return {
        let _ = data_dir;
        Box::new(StoreElectronKeys::new(crate::keychain::MacKeychain::default()))
    };
    #[cfg(target_os = "linux")]
    return {
        let _ = data_dir;
        Box::new(StoreElectronKeys::new(crate::secret_service::SecretService::new()))
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = data_dir;
        Box::new(NoKeys)
    }
}

/// Opens `<data_dir>/account.json` as written by Electron and returns the account JSON text.
pub fn open_electron_account_json(data_dir: &Path) -> Result<Zeroizing<Vec<u8>>, OsealError> {
    let platform = current_platform().ok_or(OsealError::Unavailable)?;
    open_electron_account_json_with(data_dir, platform, &*electron_key_provider(data_dir))
}

pub fn open_electron_account_json_with(
    data_dir: &Path,
    platform: Platform,
    provider: &dyn OsKeyProvider,
) -> Result<Zeroizing<Vec<u8>>, OsealError> {
    let file = read_account_file(&data_dir.join(ACCOUNT_FILE))?;
    if file.seal != "os" {
        return Err(OsealError::Unsupported);
    }
    Ok(decode(platform, &file.data, provider)?)
}

struct AccountFile {
    seal: String,
    /// The sealed bytes (not secret).
    data: Vec<u8>,
}

fn read_capped(path: &Path, cap: u64) -> Result<Zeroizing<Vec<u8>>, OsealError> {
    let mut out = Zeroizing::new(Vec::new());
    std::fs::File::open(path)?.take(cap + 1).read_to_end(&mut out)?;
    if out.len() as u64 > cap {
        return Err(OsealError::Failed);
    }
    Ok(out)
}

fn read_account_file(path: &Path) -> Result<AccountFile, OsealError> {
    parse_account_file(&read_capped(path, FILE_CAP)?)
}

fn parse_account_file(bytes: &[u8]) -> Result<AccountFile, OsealError> {
    let json: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| OsealError::Failed)?;
    if json.get("format").and_then(|v| v.as_str()) != Some("kasboek-account") {
        return Err(OsealError::Failed);
    }
    let seal = json.get("seal").and_then(|v| v.as_str()).ok_or(OsealError::Failed)?.to_owned();
    let data = base64_decode(json.get("data").and_then(|v| v.as_str()).ok_or(OsealError::Failed)?).ok_or(OsealError::Failed)?;
    Ok(AccountFile { seal, data })
}

/// A prepared migration; nothing is written until [`MigrationPlan::apply`].
#[derive(Debug)]
pub struct MigrationPlan {
    account: PathBuf,
    backup: PathBuf,
    /// The bytes of account.json when the plan was made, to notice a change before replacing it.
    original: Vec<u8>,
    /// The new account.json (sealed, not secret).
    new_file: Vec<u8>,
}

impl MigrationPlan {
    pub fn backup_path(&self) -> &Path {
        &self.backup
    }

    pub fn new_file(&self) -> &[u8] {
        &self.new_file
    }

    /// 1. Keep the original as `account.electron.json` (kept as is when it already exists: it is the first original).
    /// 2. Write the new file next to account.json (fresh, mode 0600, fsync) and rename it over account.json.
    pub fn apply(&self) -> Result<(), OsealError> {
        let now = std::fs::read(&self.account)?;
        if now != self.original {
            return Err(OsealError::Changed);
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).mode_0600().open(&self.backup) {
            Ok(mut f) => {
                f.write_all(&self.original)?;
                f.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let tmp = self.account.with_extension("json.tmp");
        match std::fs::remove_file(&tmp) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode_0600().open(&tmp)?;
        f.write_all(&self.new_file)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &self.account)?;
        #[cfg(unix)]
        if let Some(dir) = self.account.parent() {
            std::fs::File::open(dir)?.sync_all()?;
        }
        Ok(())
    }
}

trait Mode0600 {
    fn mode_0600(&mut self) -> &mut Self;
}

impl Mode0600 for std::fs::OpenOptions {
    #[cfg(unix)]
    fn mode_0600(&mut self) -> &mut Self {
        std::os::unix::fs::OpenOptionsExt::mode(self, 0o600)
    }

    #[cfg(not(unix))]
    fn mode_0600(&mut self) -> &mut Self {
        self
    }
}

/// Plans the move from an Electron-sealed account.json to `new_seal`. `Ok(None)` when there is nothing to do (no file,
/// `seal:'none'`, or already `os-native`). The new blob is opened again and compared before the plan is returned.
/// Refuses (`Unavailable`) when `new_seal` is missing or weak: the Electron seal stays in place then.
pub fn plan_migration_with(
    data_dir: &Path,
    platform: Platform,
    provider: &dyn OsKeyProvider,
    new_seal: &dyn OsSeal,
) -> Result<Option<MigrationPlan>, OsealError> {
    let account = data_dir.join(ACCOUNT_FILE);
    let original = match std::fs::read(&account) {
        Ok(bytes) if bytes.len() as u64 <= FILE_CAP => bytes,
        Ok(_) => return Err(OsealError::Failed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let file = parse_account_file(&original)?;
    match file.seal.as_str() {
        "none" | NATIVE_SEAL => return Ok(None),
        "os" => {}
        _ => return Err(OsealError::Unsupported),
    }
    if !file.data.starts_with(b"v10") && !file.data.starts_with(b"v11") {
        return Err(OsealError::Unsupported);
    }
    if new_seal.protection() != KeyProtection::Os {
        return Err(OsealError::Unavailable);
    }
    let plain = decode(platform, &file.data, provider)?;
    let sealed = new_seal.seal(&plain)?;
    if new_seal.unseal(&sealed)?.as_slice() != plain.as_slice() {
        return Err(OsealError::Failed);
    }
    let mut encoded = base64_encode(&sealed);
    let new_file = format!(r#"{{"format":"kasboek-account","version":2,"seal":"{NATIVE_SEAL}","data":"{encoded}"}}"#).into_bytes();
    encoded.zeroize();
    Ok(Some(MigrationPlan { account, backup: data_dir.join(BACKUP_FILE), original, new_file }))
}

/// [`plan_migration_with`] with this OS's Electron key material.
pub fn plan_migration(data_dir: &Path, new_seal: &dyn OsSeal) -> Result<Option<MigrationPlan>, OsealError> {
    let platform = current_platform().ok_or(OsealError::Unavailable)?;
    plan_migration_with(data_dir, platform, &*electron_key_provider(data_dir), new_seal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dpapi::fake::ReverseDpapi;
    use crate::wrap::fake::FakeStore;
    use crate::wrap::WrapKeySeal;
    use serde_json::Value;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../parity/fixtures-session/oscrypt.json")).unwrap()
    }

    fn hex(v: &Value) -> Vec<u8> {
        hex::decode(v.as_str().unwrap()).unwrap()
    }

    fn write_account(dir: &Path, seal: &str, data: &[u8]) {
        let text = format!(r#"{{"format":"kasboek-account","version":2,"seal":"{seal}","data":"{}"}}"#, base64_encode(data));
        std::fs::write(dir.join(ACCOUNT_FILE), text).unwrap();
    }

    fn windows_keys(dir: &Path, f: &Value) -> WindowsElectronKeys {
        std::fs::write(dir.join(LOCAL_STATE_FILE), f["windows"]["localState"].as_str().unwrap()).unwrap();
        WindowsElectronKeys::new(dir, Box::new(ReverseDpapi))
    }

    #[test]
    fn windows_provider_reads_local_state_and_opens_the_file() {
        let f = fixtures();
        let dir = tempfile::tempdir().unwrap();
        let keys = windows_keys(dir.path(), &f);
        write_account(dir.path(), "os", &hex(&f["windows"]["blobHex"]));
        // The fake of this crate adds an entropy tag only when entropy is given; Chromium's is without, so it is a plain reverse.
        let plain = open_electron_account_json_with(dir.path(), Platform::Windows, &keys).unwrap();
        assert_eq!(plain.as_slice(), f["plain"].as_str().unwrap().as_bytes());
    }

    #[test]
    fn missing_local_state_and_none_seal_are_refused() {
        let f = fixtures();
        let dir = tempfile::tempdir().unwrap();
        let keys = WindowsElectronKeys::new(dir.path(), Box::new(ReverseDpapi));
        write_account(dir.path(), "os", &hex(&f["windows"]["blobHex"]));
        assert_eq!(open_electron_account_json_with(dir.path(), Platform::Windows, &keys).unwrap_err(), OsealError::Unavailable);
        write_account(dir.path(), "none", b"{}");
        assert_eq!(open_electron_account_json_with(dir.path(), Platform::Windows, &keys).unwrap_err(), OsealError::Unsupported);
        assert_eq!(
            open_electron_account_json_with(&dir.path().join("nope"), Platform::Windows, &keys).unwrap_err(),
            OsealError::Io(std::io::ErrorKind::NotFound)
        );
    }

    #[test]
    fn store_provider_gives_the_keyring_password_for_v11_and_nothing_for_v10() {
        let f = fixtures();
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        store.items.lock().unwrap().insert("electron", f["linuxV11"]["password"].as_str().unwrap().as_bytes().to_vec());
        let keys = StoreElectronKeys::new(store);
        write_account(dir.path(), "os", &hex(&f["linuxV11"]["blobHex"]));
        assert_eq!(
            open_electron_account_json_with(dir.path(), Platform::Linux, &keys).unwrap().as_slice(),
            f["plain"].as_str().unwrap().as_bytes()
        );
        // No keyring item: v11 cannot be opened, v10 (peanuts) can.
        let empty = StoreElectronKeys::new(FakeStore::default());
        assert_eq!(open_electron_account_json_with(dir.path(), Platform::Linux, &empty).unwrap_err(), OsealError::Unavailable);
        write_account(dir.path(), "os", &hex(&f["linuxV10"]["blobHex"]));
        assert_eq!(
            open_electron_account_json_with(dir.path(), Platform::Linux, &empty).unwrap().as_slice(),
            f["plain"].as_str().unwrap().as_bytes()
        );
        let locked = StoreElectronKeys::new(FakeStore { locked: true, ..FakeStore::default() });
        write_account(dir.path(), "os", &hex(&f["linuxV11"]["blobHex"]));
        assert_eq!(open_electron_account_json_with(dir.path(), Platform::Linux, &locked).unwrap_err(), OsealError::Unavailable);
    }

    #[test]
    fn migration_reseals_keeps_the_backup_and_is_idempotent() {
        let f = fixtures();
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        store.items.lock().unwrap().insert("electron", f["macos"]["password"].as_str().unwrap().as_bytes().to_vec());
        // The wrap key store and the Electron password live in one fake here.
        let keys = StoreElectronKeys::new(store);
        let blob = hex(&f["macos"]["blobHex"]);
        write_account(dir.path(), "os", &blob);
        let original = std::fs::read(dir.path().join(ACCOUNT_FILE)).unwrap();
        let native = WrapKeySeal::new(FakeStore::default());

        let plan = plan_migration_with(dir.path(), Platform::Macos, &keys, &native).unwrap().unwrap();
        // Nothing is written by planning.
        assert_eq!(std::fs::read(dir.path().join(ACCOUNT_FILE)).unwrap(), original);
        assert!(!dir.path().join(BACKUP_FILE).exists());
        plan.apply().unwrap();

        assert_eq!(std::fs::read(dir.path().join(BACKUP_FILE)).unwrap(), original);
        let now = std::fs::read(dir.path().join(ACCOUNT_FILE)).unwrap();
        assert_eq!(now, plan.new_file());
        let parsed = parse_account_file(&now).unwrap();
        assert_eq!(parsed.seal, NATIVE_SEAL);
        assert_eq!(native.unseal(&parsed.data).unwrap().as_slice(), f["plain"].as_str().unwrap().as_bytes());
        assert!(!dir.path().join("account.json.tmp").exists());
        // Done: nothing more to plan, and a stale plan is refused rather than clobbering the new file.
        assert!(plan_migration_with(dir.path(), Platform::Macos, &keys, &native).unwrap().is_none());
        assert_eq!(plan.apply().unwrap_err(), OsealError::Changed);
        assert_eq!(std::fs::read(dir.path().join(BACKUP_FILE)).unwrap(), original);
    }

    #[test]
    fn migration_does_not_overwrite_an_existing_backup_and_refuses_weak_seals() {
        let f = fixtures();
        let dir = tempfile::tempdir().unwrap();
        write_account(dir.path(), "os", &hex(&f["linuxV10"]["blobHex"]));
        std::fs::write(dir.path().join(BACKUP_FILE), b"first original").unwrap();
        let keys = NoKeys;
        let native = WrapKeySeal::new(FakeStore::default());
        plan_migration_with(dir.path(), Platform::Linux, &keys, &native).unwrap().unwrap().apply().unwrap();
        assert_eq!(std::fs::read(dir.path().join(BACKUP_FILE)).unwrap(), b"first original");

        write_account(dir.path(), "os", &hex(&f["linuxV10"]["blobHex"]));
        let down = WrapKeySeal::new(FakeStore { down: true, ..FakeStore::default() });
        assert_eq!(plan_migration_with(dir.path(), Platform::Linux, &keys, &down).unwrap_err(), OsealError::Unavailable);
        let weak = kb_session::seal::FileSeal::weak([3; 32]);
        assert_eq!(plan_migration_with(dir.path(), Platform::Linux, &keys, &weak).unwrap_err(), OsealError::Unavailable);
    }

    #[test]
    fn migration_skips_other_files_and_refuses_unknown_ones() {
        let dir = tempfile::tempdir().unwrap();
        let native = WrapKeySeal::new(FakeStore::default());
        assert!(plan_migration_with(dir.path(), Platform::Linux, &NoKeys, &native).unwrap().is_none());
        write_account(dir.path(), "none", b"{}");
        assert!(plan_migration_with(dir.path(), Platform::Linux, &NoKeys, &native).unwrap().is_none());
        write_account(dir.path(), "os", b"KBK1 something");
        assert_eq!(plan_migration_with(dir.path(), Platform::Linux, &NoKeys, &native).unwrap_err(), OsealError::Unsupported);
        write_account(dir.path(), "weird", b"x");
        assert_eq!(plan_migration_with(dir.path(), Platform::Linux, &NoKeys, &native).unwrap_err(), OsealError::Unsupported);
        std::fs::write(dir.path().join(ACCOUNT_FILE), b"not json").unwrap();
        assert_eq!(plan_migration_with(dir.path(), Platform::Linux, &NoKeys, &native).unwrap_err(), OsealError::Failed);
    }
}
