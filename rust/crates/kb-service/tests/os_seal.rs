//! The OS seal at service level, with fakes that implement the `OsSeal` and `DeviceAuth` traits: the migration of an
//! Electron-style account.json (invented data), its failures, and device (passwordless) accounts. Nothing here touches the
//! real keyring.
use kb_crypto::slot::Argon2Cost;
use kb_service::{block_on, AppError, AppService, CoreOptions, CoreService};
use kb_session::device::{DeviceKind, FakeDevice};
use kb_session::oscrypt::SealError;
use kb_session::seal::{FileSeal, OsSeal, Unsupported};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use zeroize::Zeroizing;

const PASSWORD: &str = "Tulip-Harbour-Lantern-48";

/// A native seal in the test: the blob of `FileSeal`, written as `seal:'os-native'` like `kb-oseal` does.
struct NativeFake(FileSeal);

impl OsSeal for NativeFake {
    fn available(&self) -> bool {
        self.0.available()
    }

    fn seal_value(&self) -> &'static str {
        "os-native"
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, SealError> {
        self.0.seal(plain)
    }

    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        self.0.unseal(sealed)
    }
}

fn native() -> Box<dyn OsSeal> {
    Box::new(NativeFake(FileSeal::new([5; 32])))
}

fn options(dir: &Path, seal: Box<dyn OsSeal>) -> CoreOptions {
    let mut options = CoreOptions::new(dir.to_path_buf());
    options.seal = seal;
    options.cost = Some(Argon2Cost { m: 64, t: 1, p: 1 });
    options
}

fn call(service: &CoreService, op: &str, input: Value) -> Result<Value, AppError> {
    block_on(service.invoke(op, input))
}

fn account_seal(dir: &Path) -> String {
    let file: Value = serde_json::from_slice(&std::fs::read(dir.join("account.json")).unwrap()).unwrap();
    file["seal"].as_str().unwrap().to_owned()
}

/// An account.json as Electron (Linux, `v10`, no keyring needed) wrote it for the password above.
#[cfg(target_os = "linux")]
fn electron_folder() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("account.json"), include_bytes!("fixtures/electron-account.json")).unwrap();
    dir
}

#[cfg(target_os = "linux")]
#[test]
fn an_electron_account_is_moved_to_the_native_seal_and_unlocks() {
    let dir = electron_folder();
    let original = std::fs::read(dir.path().join("account.json")).unwrap();
    let mut o = options(dir.path(), native());
    o.migrate_electron = true;
    let service = CoreService::open(o).unwrap();
    let status = call(&service, "auth.status", json!({})).unwrap();
    assert_eq!((status["state"].as_str(), status["mode"].as_str(), status["error"].is_null()), (Some("locked"), Some("password"), true));
    // Moved: the file is native now and the Electron original is kept until the first successful unlock.
    assert_eq!(account_seal(dir.path()), "os-native");
    assert_eq!(std::fs::read(dir.path().join("account.electron.json")).unwrap(), original);
    assert_eq!(call(&service, "auth.unlock", json!({ "password": "Wrong-Password-12345" })).unwrap_err().code, "auth.failed");
    assert!(dir.path().join("account.electron.json").exists());
    assert_eq!(call(&service, "auth.unlock", json!({ "password": PASSWORD })).unwrap()["state"], "unlocked");
    assert!(call(&service, "accounts.list", json!({})).unwrap().as_array().unwrap().is_empty());
    assert!(!dir.path().join("account.electron.json").exists());
    // A second start reads the native file as it is.
    drop(service);
    let mut o = options(dir.path(), native());
    o.migrate_electron = true;
    let again = CoreService::open(o).unwrap();
    assert_eq!(call(&again, "auth.unlock", json!({ "password": PASSWORD })).unwrap()["state"], "unlocked");
}

#[cfg(target_os = "linux")]
#[test]
fn a_failed_migration_is_said_on_the_lock_screen_and_changes_nothing() {
    let dir = electron_folder();
    let original = std::fs::read(dir.path().join("account.json")).unwrap();
    // No usable seal: the Electron file stays, the status says why.
    let mut o = options(dir.path(), Box::new(Unsupported));
    o.migrate_electron = true;
    let service = CoreService::open(o).unwrap();
    let status = call(&service, "auth.status", json!({})).unwrap();
    assert_eq!(status["state"], "locked");
    assert_eq!(status["error"]["code"], "auth.migration_failed");
    assert!(status["error"]["message"].as_str().unwrap().contains("Nothing was changed"));
    assert_eq!(std::fs::read(dir.path().join("account.json")).unwrap(), original);
    assert!(!dir.path().join("account.electron.json").exists());
    assert!(call(&service, "auth.unlock", json!({ "password": PASSWORD })).is_err());
}

#[test]
fn a_password_account_without_an_electron_file_needs_no_migration() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options(dir.path(), native());
    o.migrate_electron = true;
    let service = CoreService::open(o).unwrap();
    call(&service, "auth.setup", json!({ "mode": "password", "password": PASSWORD })).unwrap();
    assert_eq!(account_seal(dir.path()), "os-native");
    assert!(!dir.path().join("account.electron.json").exists());
}

#[test]
fn a_device_account_is_created_and_unlocked_with_the_native_seal() {
    let dir = tempfile::tempdir().unwrap();
    let device = Arc::new(FakeDevice::new(Some(DeviceKind::WindowsHello), true));
    let mut o = options(dir.path(), native());
    o.device = Box::new(SharedDevice(device.clone()));
    let service = CoreService::open(o).unwrap();
    call(&service, "auth.setup", json!({ "mode": "device" })).unwrap();
    assert_eq!(account_seal(dir.path()), "os-native");
    call(&service, "auth.lock", json!({})).unwrap();
    let status = call(&service, "auth.status", json!({})).unwrap();
    assert_eq!((status["mode"].as_str(), status["device"].as_str()), (Some("device"), Some("windows-hello")));
    device.set(Some(DeviceKind::WindowsHello), false);
    assert_eq!(call(&service, "auth.unlock", json!({})).unwrap_err().code, "auth.device_failed");
    device.set(Some(DeviceKind::WindowsHello), true);
    assert_eq!(call(&service, "auth.unlock", json!({})).unwrap()["state"], "unlocked");
}

#[test]
fn a_device_account_is_refused_without_a_usable_seal() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options(dir.path(), Box::new(Unsupported));
    o.device = Box::new(FakeDevice::new(Some(DeviceKind::WindowsHello), true));
    let service = CoreService::open(o).unwrap();
    assert!(call(&service, "auth.setup", json!({ "mode": "device" })).is_err());
    assert_eq!(call(&service, "auth.status", json!({})).unwrap()["state"], "setup");
}

#[test]
fn asking_whether_the_system_can_seal_changes_nothing() {
    // Whatever the machine has (a keyring, none, a locked one): an answer, and no file written.
    let dir = tempfile::tempdir().unwrap();
    let _ = kb_service::os_seal_available(dir.path());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

/// `FakeDevice` is owned by the service; the test keeps a handle to change its answers.
struct SharedDevice(Arc<FakeDevice>);

impl kb_session::device::DeviceAuth for SharedDevice {
    fn peek(&self) -> Option<Option<DeviceKind>> {
        self.0.peek()
    }

    fn kind(&self) -> Option<DeviceKind> {
        self.0.kind()
    }

    fn verify(&self, reason: &str) -> Result<bool, kb_session::SessionError> {
        self.0.verify(reason)
    }
}
