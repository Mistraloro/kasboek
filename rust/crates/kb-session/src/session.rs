//! Login state: `setup` | `locked` | `unlocked`. While locked, the database is closed and no key is held in memory.
//! Port of src/main/session.ts, synchronous (the OS prompts are behind [`DeviceAuth`]; run the calls on a worker thread).
//!
//! Differences from the TypeScript on purpose:
//! - A passwordless (device) account is not OS-unsealed at start-up or after a lock until the person has passed the
//!   device check (plan section 5, "nothing decrypted before authentication"). Until then the Lock screen's facts come
//!   from a non-secret [`Hint`] (the prefs `lastAuth`). Without a hint the account is opened at start-up as before.
//! - `lock()` zeroizes the master key, the vault and the pending 2FA secret by dropping them (all `Zeroizing`), and
//!   puts a device account back to the sealed state.
//! - Whatever way a call ends without an open database (wrong code, throttle, cancelled prompt, failed database open),
//!   a device account is put back to the sealed state: its master key is never kept in memory while locked.
//! - Hardening the TypeScript lacks: a remembered-computer date more than 30 days ahead is refused, and the throttle
//!   never waits longer than its own delay when the last failure is dated in the future (see account.rs).
//! - The QR code of `totpBegin` comes from a hook ([`Session::set_qr_renderer`]); the default gives an empty string.
use crate::account::{
    check_throttle, check_throttle_for, create_account, forget_remembered, new_totp_secret, record_failure, remembered_until,
    rotate_recovery_key, set_password, set_passwordless, set_two_factor, store_vault, throttle_for, throttle_seconds, unlock_with_device,
    unlock_with_password, unlock_with_recovery, AccountData, Attempts, AuthMode, Crypto, Outcome, UnlockOptions,
};
use crate::device::{DeviceAuth, DeviceKind};
use crate::error::{SessionError, SessionResult};
use crate::password::check_password;
use crate::paths::Paths;
use crate::quarantine::{list_erased, purge_erased, quarantine_data, restore_erased};
use crate::seal::{KeyProtection, OsSeal};
use crate::store::AccountStore;
use crate::time::{iso, random_array, Clock, Rng};
use kb_crypto::slot::{open_slot, Argon2Cost, SlotKind, PASSWORD_KDF};
use kb_crypto::totp::{otpauth_uri, verify_totp};
use kb_crypto::vault::{Totp, Vault};
use kb_crypto::Master;
use kb_db::{DbKey, OpenOptions, Store};
use serde::Serialize;
use std::ops::{Deref, DerefMut};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    User,
    Idle,
    System,
}

impl LockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Idle => "idle",
            Self::System => "system",
        }
    }
}

/// `AppEvent` of the contract, the two the session sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Locked(LockReason),
    Refresh,
}

/// What the Lock screen may know before the account is opened (prefs `lastAuth`). Not secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hint {
    pub mode: AuthMode,
    pub two_factor: bool,
    pub remembered_until: Option<String>,
    pub attempts: Attempts,
}

impl Hint {
    fn of(account: &AccountData, now_ms: i64) -> Self {
        Self {
            mode: account.mode,
            two_factor: account.two_factor,
            remembered_until: remembered_until(account, now_ms),
            attempts: account.attempts.clone(),
        }
    }
}

// One value per session, so the size of the largest variant does not matter.
#[allow(clippy::large_enum_variant)]
enum AccountState {
    None,
    Loaded(AccountData),
    /// Device account, file read but not unsealed.
    Sealed {
        raw: crate::store::RawAccountFile,
        hint: Hint,
    },
}

struct Open<S> {
    master: Master,
    vault: Vault,
    db: S,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ErasedCopy {
    pub name: String,
    #[serde(rename = "erasedAt")]
    pub erased_at: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct StatusError {
    pub code: String,
    pub message: String,
}

/// `AuthStatus` of src/shared/types.ts, in its key order.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct AuthStatus {
    pub state: &'static str,
    pub mode: Option<&'static str>,
    #[serde(rename = "twoFactor")]
    pub two_factor: bool,
    #[serde(rename = "rememberedUntil")]
    pub remembered_until: Option<String>,
    pub device: Option<&'static str>,
    #[serde(rename = "deviceChecking")]
    pub device_checking: bool,
    #[serde(rename = "throttleSeconds")]
    pub throttle_seconds: u64,
    pub recovered: bool,
    #[serde(rename = "weakPassword")]
    pub weak_password: bool,
    #[serde(rename = "legacyData")]
    pub legacy_data: bool,
    pub erased: Vec<ErasedCopy>,
    #[serde(rename = "keyProtection")]
    pub key_protection: &'static str,
    pub error: Option<StatusError>,
}

type EventSink = Box<dyn FnMut(Event) + Send>;
type LogSink = Box<dyn FnMut(&str) + Send>;
type QrRenderer = Box<dyn Fn(&str) -> String + Send>;

pub struct Config {
    pub paths: Paths,
    pub clock: Box<dyn Clock>,
    pub rng: Box<dyn Rng>,
    pub seal: Box<dyn OsSeal>,
    pub device: Box<dyn DeviceAuth>,
    /// Argon2id cost for new password slots; tests lower it.
    pub cost: Argon2Cost,
}

impl Config {
    pub fn new(paths: Paths, clock: Box<dyn Clock>, rng: Box<dyn Rng>, seal: Box<dyn OsSeal>, device: Box<dyn DeviceAuth>) -> Self {
        Self { paths, clock, rng, seal, device, cost: PASSWORD_KDF }
    }
}

/// Not `Clone`: the password and the code are wiped when the value is dropped.
#[derive(Default)]
pub struct UnlockInput {
    pub password: Option<Zeroizing<String>>,
    pub code: Option<Zeroizing<String>>,
    pub remember: bool,
}

/// The password and the code never appear in logs.
impl std::fmt::Debug for UnlockInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockInput").field("remember", &self.remember).finish_non_exhaustive()
    }
}

/// The attempt counter that is further along: the one in memory may be ahead of the file (a failed write) or behind a hint.
fn further(a: &Attempts, b: &Attempts) -> Attempts {
    if b.failed > a.failed {
        b.clone()
    } else {
        a.clone()
    }
}

/// Wraps a call that may open a device account for a moment. However the call ends (error, early return, panic), a
/// session without an open database gets its device account sealed again.
struct Resealing<'a, S: Store>(&'a mut Session<S>);

impl<S: Store> Deref for Resealing<'_, S> {
    type Target = Session<S>;
    fn deref(&self) -> &Session<S> {
        self.0
    }
}

impl<S: Store> DerefMut for Resealing<'_, S> {
    fn deref_mut(&mut self) -> &mut Session<S> {
        self.0
    }
}

impl<S: Store> Drop for Resealing<'_, S> {
    fn drop(&mut self) {
        if self.0.open.is_none() {
            self.0.reseal_device_account();
        }
    }
}

pub struct Session<S: Store> {
    store: AccountStore,
    clock: Box<dyn Clock>,
    rng: Box<dyn Rng>,
    device: Box<dyn DeviceAuth>,
    cost: Argon2Cost,
    account: AccountState,
    load_error: Option<SessionError>,
    open: Option<Open<S>>,
    hint: Option<Hint>,
    /// Unlocked with the recovery key: the next password change needs no current password.
    recovered: bool,
    pending_totp: Option<Zeroizing<String>>,
    /// Unlocked with a password that predates the current rules.
    weak_password: bool,
    /// From creating the account until the first-run recovery key and two-factor steps end (UI state kept here).
    setup_flow_active: bool,
    lock_listeners: Vec<Box<dyn FnMut() + Send>>,
    on_event: Option<EventSink>,
    log: Option<LogSink>,
    qr: QrRenderer,
}

fn failed(code: &str, message: &str) -> SessionError {
    SessionError::new(code, message)
}

impl<S: Store> Session<S> {
    pub fn new(config: Config) -> Self {
        Self {
            store: AccountStore::new(config.paths, config.seal),
            clock: config.clock,
            rng: config.rng,
            device: config.device,
            cost: config.cost,
            account: AccountState::None,
            load_error: None,
            open: None,
            hint: None,
            recovered: false,
            pending_totp: None,
            weak_password: false,
            setup_flow_active: false,
            lock_listeners: Vec::new(),
            on_event: None,
            log: None,
            qr: Box::new(|_| String::new()),
        }
    }

    pub fn paths(&self) -> &Paths {
        &self.store.paths
    }

    pub fn on_lock(&mut self, f: impl FnMut() + Send + 'static) {
        self.lock_listeners.push(Box::new(f));
    }

    pub fn set_event_sink(&mut self, f: impl FnMut(Event) + Send + 'static) {
        self.on_event = Some(Box::new(f));
    }

    pub fn set_log_sink(&mut self, f: impl FnMut(&str) + Send + 'static) {
        self.log = Some(Box::new(f));
    }

    pub fn set_qr_renderer(&mut self, f: impl Fn(&str) -> String + Send + 'static) {
        self.qr = Box::new(f);
    }

    pub fn setup_flow_active(&self) -> bool {
        self.setup_flow_active
    }

    /// The first-run recovery key and two-factor steps are over.
    pub fn end_setup_flow(&mut self) {
        self.setup_flow_active = false;
    }

    fn crypto(&self) -> Crypto<'_> {
        Crypto { clock: &*self.clock, rng: &*self.rng, cost: self.cost }
    }

    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    fn emit(&mut self, event: Event) {
        if let Some(f) = &mut self.on_event {
            f(event);
        }
    }

    fn log(&mut self, text: &str) {
        if let Some(f) = &mut self.log {
            f(text);
        }
    }

    /* ---------- Reading the account ---------- */

    /// Reads the account file at start-up. With a `hint` that says "device", a sealed account file stays sealed.
    pub fn init(&mut self, hint: Option<Hint>) {
        self.hint = hint;
        self.read_account();
    }

    fn read_account(&mut self) {
        let result = self.store.read_raw().and_then(|raw| match raw {
            None => Ok(AccountState::None),
            Some(raw) => match &self.hint {
                Some(h) if h.mode == AuthMode::Device && raw.seal_os => Ok(AccountState::Sealed { raw, hint: h.clone() }),
                _ => self.store.open_raw(&raw).map(AccountState::Loaded),
            },
        });
        match result {
            Ok(state) => {
                self.account = state;
                self.load_error = None;
            }
            Err(e) => self.load_error = Some(e),
        }
        // Without a hint a device account had to be opened to learn its facts: it does not stay open while locked.
        if self.open.is_none() {
            self.reseal_device_account();
        }
        // Erased copies are kept for 30 days, then removed.
        let now = self.now();
        purge_erased(&self.store.paths, now);
    }

    fn account_exists_or_failed(&self) -> bool {
        !matches!(self.account, AccountState::None) || self.load_error.is_some() || self.store.exists()
    }

    /// Opens a sealed device account. Only call it after the person has been verified (or for the recovery key).
    /// The caller must make sure the account is put back when the call ends without an open database ([`Resealing`]).
    fn materialize(&mut self) -> SessionResult<()> {
        if let AccountState::Sealed { raw, hint } = &self.account {
            let mut account = self.store.open_raw(raw)?;
            // The hint carries guesses that were counted in memory but did not reach the file.
            account.attempts = further(&account.attempts, &hint.attempts);
            self.account = AccountState::Loaded(account);
        }
        Ok(())
    }

    /// The hint is only a guess (a stale or edited `lastAuth`). When the caller can't use the device check, or brings a
    /// password, the real mode decides: a password account is opened (nothing secret is in it), a device account stays
    /// sealed but its hint is corrected.
    fn refresh_stale_hint(&mut self, password_given: bool) {
        let AccountState::Sealed { raw, hint } = &self.account else { return };
        if !password_given && self.device.kind().is_some() {
            return;
        }
        let Ok(mut real) = self.store.open_raw(raw) else { return };
        real.attempts = further(&real.attempts, &hint.attempts);
        if real.mode == AuthMode::Password {
            self.account = AccountState::Loaded(real);
        } else {
            let fresh = Hint::of(&real, self.now());
            self.account = AccountState::Sealed { raw: raw.clone(), hint: fresh };
        }
    }

    fn require_account(&mut self) -> SessionResult<&AccountData> {
        if matches!(self.account, AccountState::None) {
            return Err(self.load_error.clone().unwrap_or_else(|| failed("auth.no_account", "Set up Kasboek first.")));
        }
        self.materialize()?;
        self.loaded()
    }

    fn loaded(&self) -> SessionResult<&AccountData> {
        match &self.account {
            AccountState::Loaded(a) => Ok(a),
            _ => Err(SessionError::failed()),
        }
    }

    fn account_view(&self) -> Option<Hint> {
        match &self.account {
            AccountState::None => None,
            AccountState::Loaded(a) => Some(Hint::of(a, self.now())),
            AccountState::Sealed { hint, .. } => Some(Hint {
                remembered_until: hint.remembered_until.clone().filter(|u| crate::time::parse_iso(u).is_some_and(|t| t > self.now())),
                ..hint.clone()
            }),
        }
    }

    /* ---------- Facts ---------- */

    pub fn is_unlocked(&self) -> bool {
        self.open.is_some()
    }

    pub fn db(&self) -> SessionResult<&S> {
        self.open.as_ref().map(|o| &o.db).ok_or_else(SessionError::locked)
    }

    /// For exports and backups while unlocked.
    pub fn secrets(&self) -> SessionResult<(&AccountData, &Master, &Vault)> {
        match (&self.open, &self.account) {
            (Some(o), AccountState::Loaded(a)) => Ok((a, &o.master, &o.vault)),
            _ => Err(SessionError::locked()),
        }
    }

    pub fn account_exists(&self) -> bool {
        self.store.exists()
    }

    pub fn status(&mut self) -> AuthStatus {
        // "Try again" after e.g. unlocking the system keyring.
        if self.load_error.is_some() && self.open.is_none() {
            self.read_account();
        }
        let peek = self.device.peek();
        let view = self.account_view();
        let now = self.now();
        let throttle = match (&self.account, &view) {
            (AccountState::Loaded(a), _) => throttle_seconds(a, now),
            (AccountState::Sealed { hint, .. }, _) => throttle_for(&hint.attempts, now),
            _ => 0,
        };
        AuthStatus {
            // An account file that can't be read is 'locked' with an error, never 'setup': setup would replace it.
            state: if self.open.is_some() {
                "unlocked"
            } else if view.is_some() || self.load_error.is_some() {
                "locked"
            } else {
                "setup"
            },
            mode: view.as_ref().map(|v| v.mode.as_str()),
            two_factor: view.as_ref().is_some_and(|v| v.two_factor),
            remembered_until: view.as_ref().and_then(|v| v.remembered_until.clone()),
            device: peek.flatten().map(DeviceKind::as_str),
            device_checking: peek.is_none(),
            throttle_seconds: throttle,
            recovered: self.recovered,
            weak_password: self.open.is_some() && self.weak_password,
            legacy_data: view.is_none() && self.store.read_legacy_db_key().is_some(),
            erased: list_erased(&self.store.paths)
                .into_iter()
                .map(|e| ErasedCopy { name: e.name, erased_at: iso(e.erased_at as i64) })
                .collect(),
            key_protection: self.store.key_protection().as_str(),
            error: self.load_error.as_ref().map(|e| StatusError { code: e.code.clone(), message: e.message.clone() }),
        }
    }

    fn open_with(&mut self, master: Master, vault: Vault) -> SessionResult<()> {
        let key = DbKey::from_hex(&vault.db_key)?;
        let db = S::open(&self.store.paths.db_file, &key, OpenOptions::default())?;
        self.open = Some(Open { master, vault, db });
        Ok(())
    }

    /// Saves first and only then replaces the copy in memory, so a failed write never leaves memory ahead of the file.
    /// A saved change is a credential change (password, recovery key, 2FA, mode) or an import: the Electron copy that
    /// `kb-oseal`'s migration kept would still open with the old credentials, so it goes.
    fn persist(&mut self, next: AccountData) -> SessionResult<()> {
        self.store.save(&next)?;
        self.account = AccountState::Loaded(next);
        self.drop_electron_backup();
        Ok(())
    }

    /// Removes `account.electron.json`; a failure is logged, never raised (the account itself is fine).
    fn drop_electron_backup(&mut self) {
        if self.store.remove_electron_backup().is_err() {
            self.log("[auth] could not remove account.electron.json");
        }
    }

    /// For the failed-attempt counter (and the reset after a correct login): memory is updated first, so guesses are
    /// counted even when the file can't be written; a failed write is logged, not raised.
    /// Returns whether the file was written.
    fn persist_counter(&mut self, next: AccountData) -> bool {
        let saved = self.store.save(&next).is_ok();
        self.account = AccountState::Loaded(next);
        if !saved {
            self.log("[auth] could not save the login attempts");
        }
        saved
    }

    /// Passwordless mode keeps the key in the account file: only safe when the operating system seals that file.
    fn require_os_protection(&self) -> SessionResult<()> {
        if self.store.key_protection() != KeyProtection::Os {
            return Err(failed(
                "auth.device_unprotected",
                "Windows Hello or Touch ID can only replace the password when this computer protects Kasboek’s key (Windows account, macOS Keychain or a Linux keyring). Choose a password instead.",
            ));
        }
        Ok(())
    }

    fn require_device(&self, reason: &str) -> SessionResult<()> {
        if self.device.kind().is_none() {
            return Err(failed("auth.no_device", "Windows Hello or Touch ID is not available on this computer."));
        }
        if !self.device.verify(reason)? {
            return Err(failed("auth.device_failed", "Verification was cancelled or failed."));
        }
        Ok(())
    }

    /* ---------- Setup, unlock, lock ---------- */

    pub fn setup(&mut self, mode: AuthMode, password: Option<&str>) -> SessionResult<Zeroizing<String>> {
        Resealing(self).setup_inner(mode, password)
    }

    fn setup_inner(&mut self, mode: AuthMode, password: Option<&str>) -> SessionResult<Zeroizing<String>> {
        if self.account_exists_or_failed() {
            return Err(failed("auth.exists", "Kasboek is already set up."));
        }
        if mode == AuthMode::Password && !check_password(password.unwrap_or("")).ok {
            return Err(failed("auth.weak_password", "Choose a stronger password."));
        }
        if mode == AuthMode::Device {
            self.require_os_protection()?;
            self.require_device("Set up Kasboek")?;
        }
        let legacy_key = self.store.read_legacy_db_key();
        if legacy_key.is_none() && self.store.paths.db_file.exists() {
            // A database without its account can't be opened by anyone: move it aside, don't delete it.
            let mut target = self.store.paths.db_file.as_os_str().to_owned();
            target.push(format!(".orphaned-{}", self.now()));
            std::fs::rename(&self.store.paths.db_file, std::path::PathBuf::from(target)).map_err(|_| SessionError::failed())?;
        }
        let db_key = match &legacy_key {
            Some(k) => k.clone(),
            None => Zeroizing::new(hex::encode(*random_array::<32>(&*self.rng))),
        };
        let created = create_account(&self.crypto(), mode, password, &db_key)?;
        self.persist(created.account)?;
        self.open_with(created.master, created.vault)?;
        self.setup_flow_active = true;
        if legacy_key.is_some() {
            self.store.remove_legacy_keystore();
        }
        Ok(created.recovery_key)
    }

    pub fn unlock(&mut self, input: &UnlockInput) -> SessionResult<()> {
        Resealing(self).unlock_inner(input)
    }

    fn unlock_inner(&mut self, input: &UnlockInput) -> SessionResult<()> {
        let password = input.password.as_ref().map(|p| p.as_str());
        self.refresh_stale_hint(password.is_some_and(|p| !p.is_empty()));
        let view = match self.account_view() {
            Some(v) => v,
            None => return Err(self.load_error.clone().unwrap_or_else(|| failed("auth.no_account", "Set up Kasboek first."))),
        };
        let code = input.code.as_ref().map(|c| c.as_str()).filter(|c| !c.is_empty());
        let opts = UnlockOptions { remember: input.remember };
        let outcome = if view.mode == AuthMode::Device {
            // Check the 2FA code format first so a typo doesn't cost a Hello prompt.
            let need_code = view.two_factor && view.remembered_until.is_none();
            let typed = input.code.as_ref().map_or("", |c| c.as_str()).trim();
            if need_code && !(typed.len() == 6 && typed.bytes().all(|b| b.is_ascii_digit())) {
                return Err(failed("auth.code_required", "Enter the 6-digit code from your authenticator app."));
            }
            self.require_device("Unlock Kasboek")?;
            self.materialize()?;
            let acc = self.loaded()?;
            unlock_with_device(&self.crypto(), acc, code, opts)?
        } else {
            let acc = self.loaded()?;
            unlock_with_password(&self.crypto(), acc, password.unwrap_or(""), code, opts)?
        };
        let two_factor = view.two_factor;
        match outcome {
            Outcome::Failed { account } => {
                self.persist_counter(account);
                Err(failed("auth.failed", if two_factor { "The password or code is incorrect." } else { "The password is incorrect." }))
            }
            Outcome::Ok { unlocked, account } => {
                let saved = self.persist_counter(account);
                self.recovered = false;
                self.weak_password = view.mode == AuthMode::Password && !check_password(password.unwrap_or("")).ok;
                self.open_with(unlocked.master, unlocked.vault)?;
                // The first native unlock that also wrote the file back: the Electron copy has done its job.
                if saved {
                    self.drop_electron_backup();
                }
                Ok(())
            }
        }
    }

    pub fn unlock_recovery(&mut self, recovery_key: &str) -> SessionResult<()> {
        Resealing(self).unlock_recovery_inner(recovery_key)
    }

    fn unlock_recovery_inner(&mut self, recovery_key: &str) -> SessionResult<()> {
        if matches!(self.account, AccountState::None) {
            return Err(self.load_error.clone().unwrap_or_else(|| failed("auth.no_account", "Set up Kasboek first.")));
        }
        let now = self.now();
        // The recovery key is not a device check, so the seal is not opened before the throttle (as far as the hint knows)
        // has been looked at. An extra gate only: the real check below uses the attempts of the file.
        if let AccountState::Sealed { hint, .. } = &self.account {
            check_throttle_for(&hint.attempts, now)?;
        }
        // A sealed account is opened into a local value; on failure only the counter is kept and the guard seals it again.
        let opened = match &self.account {
            AccountState::Sealed { raw, hint } => {
                let mut account = self.store.open_raw(raw)?;
                account.attempts = further(&account.attempts, &hint.attempts);
                Some(account)
            }
            _ => None,
        };
        let account = match &opened {
            Some(a) => a,
            None => self.loaded()?,
        };
        match unlock_with_recovery(&self.crypto(), account, recovery_key)? {
            Outcome::Failed { account } => {
                self.persist_counter(account);
                Err(failed("auth.failed", "That recovery key is not correct."))
            }
            Outcome::Ok { unlocked, account } => {
                let saved = self.persist_counter(account);
                self.recovered = true;
                self.open_with(unlocked.master, unlocked.vault)?;
                if saved {
                    self.drop_electron_backup();
                }
                Ok(())
            }
        }
    }

    pub fn lock(&mut self, reason: LockReason, silent: bool) {
        if self.open.is_none() {
            return;
        }
        for f in &mut self.lock_listeners {
            f();
        }
        // Dropping closes the database and wipes the master key and the vault (all `Zeroizing`).
        self.open = None;
        self.pending_totp = None;
        self.recovered = false;
        self.weak_password = false;
        self.setup_flow_active = false;
        self.reseal_device_account();
        if !silent {
            self.emit(Event::Locked(reason));
        }
    }

    /// A passwordless account holds the master key in its device slot: drop that copy from memory while locked. When the
    /// file can't be read again, the account is dropped altogether (the lock screen shows the error; "try again" reads it
    /// anew, and the hint keeps a device account sealed then): a key in memory is the worse outcome.
    fn reseal_device_account(&mut self) {
        let AccountState::Loaded(acc) = &self.account else { return };
        if acc.mode != AuthMode::Device {
            return;
        }
        let hint = Hint::of(acc, self.clock.now_ms());
        match self.store.read_raw() {
            Ok(Some(raw)) => self.account = AccountState::Sealed { raw, hint },
            Ok(None) => self.account = AccountState::None,
            Err(e) => {
                self.account = AccountState::None;
                self.load_error = Some(e);
                self.hint = Some(hint);
            }
        }
    }

    /// Closes the database without telling the UI, e.g. right before an import replaces it.
    pub fn close_for_replace(&mut self) {
        self.lock(LockReason::User, true);
    }

    /// Auto-lock: call about every 15 seconds with the system idle time and the `autoLockMinutes` preference.
    pub fn auto_lock_tick(&mut self, idle_seconds: u64, auto_lock_minutes: u64) {
        if self.open.is_some() && auto_lock_minutes > 0 && idle_seconds >= auto_lock_minutes * 60 {
            self.lock(LockReason::Idle, false);
        }
    }

    /// The system locked the screen or went to sleep.
    pub fn on_system_lock(&mut self) {
        self.lock(LockReason::System, false);
    }

    /// Moves the data into quarantine and starts fresh. In passwordless mode the device check must confirm first.
    pub fn erase(&mut self) -> SessionResult<()> {
        if self.account_view().is_some_and(|v| v.mode == AuthMode::Device) {
            self.require_device("Erase Kasboek")?;
        }
        self.lock(LockReason::User, false);
        let now = self.now();
        let mut lines: Vec<String> = Vec::new();
        let result = quarantine_data(&self.store.paths, now, &mut |t| lines.push(t.to_owned()));
        for l in lines {
            self.log(&l);
        }
        if let Err(err) = result {
            // quarantine_data puts back what it moved; reading the account again makes memory match what is on disk.
            self.read_account();
            return Err(failed("auth.erase_failed", &format!("Could not set the data aside, so erasing was stopped: {err}")));
        }
        self.account = AccountState::None;
        self.load_error = None;
        // The hint described the account that is gone.
        self.hint = None;
        Ok(())
    }

    /// Brings back one erased copy, by the name from `status().erased`. It needs the original password or recovery key.
    pub fn restore_erased_data(&mut self, name: &str) -> SessionResult<()> {
        if self.account_exists_or_failed() {
            return Err(failed(
                "auth.restore_blocked",
                "Kasboek is already set up. Restoring erased data is only possible on the first screen.",
            ));
        }
        let now = self.now();
        let result = restore_erased(&self.store.paths, name, now);
        // The hint described the account that was erased, not the one that comes back.
        self.hint = None;
        // Also after a failure: memory has to match what is on disk, or the first screen is stuck on the old state.
        self.read_account();
        result
    }

    /* ---------- Changes ---------- */

    /// Re-checks who is at the keyboard before a sensitive change. Wrong passwords count and slow down, as at unlock.
    pub fn reauth(&mut self, password: Option<&str>) -> SessionResult<()> {
        self.secrets()?;
        self.require_account()?;
        if self.recovered {
            return Ok(());
        }
        let now = self.now();
        let acc = self.loaded()?;
        if acc.mode == AuthMode::Device {
            return self.require_device("Confirm it is you");
        }
        check_throttle(acc, now)?;
        let ok = match (password.filter(|p| !p.is_empty()), &acc.slots.password) {
            (Some(p), Some(slot)) => open_slot(slot, p, SlotKind::Password)?.is_some(),
            _ => false,
        };
        if !ok {
            let next = record_failure(acc, now);
            self.persist_counter(next);
            return Err(failed("auth.failed", "The current password is incorrect."));
        }
        if acc.attempts.failed > 0 {
            let mut next = acc.clone();
            next.attempts = Attempts { failed: 0, last_failed_at: None };
            self.persist_counter(next);
        }
        Ok(())
    }

    fn master_copy(&self) -> SessionResult<Master> {
        let (_, master, _) = self.secrets()?;
        Ok(Zeroizing::new(**master))
    }

    pub fn change_password(&mut self, current: Option<&str>, next: &str) -> SessionResult<()> {
        let master = self.master_copy()?;
        self.reauth(current)?;
        if !check_password(next).ok {
            return Err(failed("auth.weak_password", "Choose a stronger password."));
        }
        let account = self.require_account()?.clone();
        let updated = set_password(&self.crypto(), &account, &master, next)?;
        self.persist(updated)?;
        self.recovered = false;
        self.weak_password = false;
        Ok(())
    }

    pub fn switch_to_passwordless(&mut self, current_password: Option<&str>) -> SessionResult<()> {
        let master = self.master_copy()?;
        self.require_os_protection()?;
        self.reauth(current_password)?;
        self.require_device("Use Windows Hello or Touch ID for Kasboek")?;
        let account = self.require_account()?.clone();
        self.persist(set_passwordless(&account, &master))?;
        self.recovered = false;
        Ok(())
    }

    pub fn new_recovery_key(&mut self, password: Option<&str>) -> SessionResult<Zeroizing<String>> {
        let master = self.master_copy()?;
        self.reauth(password)?;
        let account = self.require_account()?.clone();
        let (updated, key) = rotate_recovery_key(&self.crypto(), &account, &master)?;
        self.persist(updated)?;
        Ok(key)
    }

    pub fn forget_this_computer(&mut self) -> SessionResult<()> {
        self.secrets()?;
        let account = self.require_account()?.clone();
        self.persist(forget_remembered(account))
    }

    /// Starts 2FA set-up: returns the secret in groups of four, the `otpauth://` URI and the QR code (SVG).
    pub fn totp_begin(&mut self) -> SessionResult<(Zeroizing<String>, Zeroizing<String>, String)> {
        self.secrets()?;
        let secret = new_totp_secret(&*self.rng);
        let uri = Zeroizing::new(otpauth_uri(&secret, "Kasboek"));
        let qr = (self.qr)(&uri);
        let grouped = secret.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("base32 is ASCII")).collect::<Vec<_>>().join(" ");
        self.pending_totp = Some(secret);
        Ok((Zeroizing::new(grouped), uri, qr))
    }

    pub fn totp_enable(&mut self, code: &str) -> SessionResult<()> {
        self.secrets()?;
        let Some(pending) = self.pending_totp.clone() else {
            return Err(failed("auth.totp_expired", "Start the set-up again."));
        };
        let now = self.now();
        let Some(step) = verify_totp(&pending, code, -1, now as f64 / 1000.0)? else {
            return Err(failed("auth.failed", "That code is not correct. Check the time on your phone and try again."));
        };
        let (account, vault) = {
            let (account, master, vault) = self.secrets()?;
            set_two_factor(account, master, vault, Some(Totp { secret: pending, last_step: step }))
        };
        self.pending_totp = None;
        if let Some(o) = &mut self.open {
            o.vault = vault;
        }
        self.persist(account)
    }

    pub fn totp_disable(&mut self, code: &str) -> SessionResult<()> {
        let now = self.now();
        let step = {
            let (_, _, vault) = self.secrets()?;
            match &vault.totp {
                Some(t) => verify_totp(&t.secret, code, t.last_step, now as f64 / 1000.0)?,
                None => None,
            }
        };
        if step.is_none() && !self.recovered {
            return Err(failed("auth.failed", "That code is not correct."));
        }
        let (account, vault) = {
            let (account, master, vault) = self.secrets()?;
            set_two_factor(account, master, vault, None)
        };
        if let Some(o) = &mut self.open {
            o.vault = vault;
        }
        self.persist(account)
    }

    /// Whether a master key is retrievable from this value (an open database or a device slot in memory).
    #[cfg(test)]
    fn holds_master_key(&self) -> bool {
        self.open.is_some() || matches!(&self.account, AccountState::Loaded(a) if a.slots.device.is_some())
    }

    /// Used by import: replaces the account and opens the imported database.
    pub fn adopt(&mut self, next: AccountData, master: Master, vault: Vault, was_recovery: bool) -> SessionResult<()> {
        Resealing(self).adopt_inner(next, master, vault, was_recovery)
    }

    fn adopt_inner(&mut self, next: AccountData, master: Master, vault: Vault, was_recovery: bool) -> SessionResult<()> {
        if self.open.is_some() {
            self.close_for_replace();
        }
        let stored = store_vault(&next, &master, &vault);
        let mode = stored.mode;
        self.persist(stored)?;
        self.load_error = None;
        self.open_with(master, vault)?;
        self.recovered = was_recovery && mode == AuthMode::Password;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::FakeDevice;
    use crate::seal::FileSeal;
    use crate::time::{ManualClock, SeededRng};
    use kb_db::SqliteStore;
    use std::sync::Arc;

    const T0: i64 = 1_790_000_000_000;
    const KEY: [u8; 32] = [7; 32];

    struct Fx {
        dir: tempfile::TempDir,
        clock: Arc<ManualClock>,
        device: Arc<FakeDevice>,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
                clock: Arc::new(ManualClock::new(T0)),
                device: Arc::new(FakeDevice::new(Some(DeviceKind::TouchId), true)),
            }
        }

        fn session(&self, key: [u8; 32], hint: Option<Hint>) -> Session<SqliteStore> {
            let mut config = Config::new(
                Paths::in_dir(self.dir.path()),
                Box::new(self.clock.clone()),
                Box::new(SeededRng::new(5)),
                Box::new(FileSeal::new(key)),
                Box::new(self.device.clone()),
            );
            config.cost = Argon2Cost { m: 64, t: 1, p: 1 };
            let mut s = Session::new(config);
            s.init(hint);
            s
        }

        /// A locked passwordless account with 2FA, and the 2FA secret. Returns the recovery key too.
        fn device_account(&self) -> (Zeroizing<String>, String) {
            let mut s = self.session(KEY, None);
            let key = s.setup(AuthMode::Device, None).unwrap();
            let (secret, _, _) = s.totp_begin().unwrap();
            let code = kb_crypto::totp::totp_at(&secret.replace(' ', ""), T0 / 1000, 6).unwrap();
            s.totp_enable(&code).unwrap();
            s.lock(LockReason::User, true);
            (key, secret.replace(' ', ""))
        }

        fn hint(&self, failed: u64) -> Hint {
            Hint {
                mode: AuthMode::Device,
                two_factor: true,
                remembered_until: None,
                attempts: Attempts { failed, last_failed_at: (failed > 0).then(|| iso(T0)) },
            }
        }

        fn failed_in_file(&self) -> u64 {
            let file: serde_json::Value = serde_json::from_slice(&std::fs::read(self.dir.path().join("account.json")).unwrap()).unwrap();
            let data = kb_crypto::encoding::base64_decode(file["data"].as_str().unwrap()).unwrap();
            let account: serde_json::Value =
                serde_json::from_slice(&crate::seal::OsSeal::unseal(&FileSeal::new(KEY), &data).unwrap()).unwrap();
            account["attempts"]["failed"].as_u64().unwrap()
        }
    }

    fn input(code: Option<&str>) -> UnlockInput {
        UnlockInput { code: code.map(|c| Zeroizing::new(c.to_owned())), ..Default::default() }
    }

    #[test]
    fn a_failed_device_prompt_leaves_nothing_unsealed() {
        let f = Fx::new();
        f.device_account();
        for hint in [Some(f.hint(0)), None] {
            let mut s = f.session(KEY, hint);
            assert!(!s.holds_master_key());
            f.device.set(Some(DeviceKind::TouchId), false);
            assert_eq!(s.unlock(&input(Some("123456"))).unwrap_err().code, "auth.device_failed");
            assert!(!s.holds_master_key());
        }
    }

    #[test]
    fn a_passed_prompt_followed_by_a_wrong_code_or_the_throttle_seals_the_account_again() {
        let f = Fx::new();
        f.device_account();
        let mut s = f.session(KEY, Some(f.hint(0)));
        for _ in 0..5 {
            assert_eq!(s.unlock(&input(Some("000000"))).unwrap_err().code, "auth.failed");
            assert!(!s.holds_master_key());
        }
        assert_eq!(f.failed_in_file(), 5);
        assert_eq!(s.unlock(&input(Some("000000"))).unwrap_err().code, "auth.throttled");
        assert!(!s.holds_master_key());
        // The status still shows the lock screen of a device account, with the counted throttle.
        let status = s.status();
        assert_eq!((status.state, status.mode, status.throttle_seconds), ("locked", Some("device"), 30));
    }

    #[test]
    fn a_failed_recovery_attempt_counts_and_seals_the_account_again() {
        let f = Fx::new();
        f.device_account();
        let mut s = f.session(KEY, Some(f.hint(0)));
        assert_eq!(s.unlock_recovery("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH").unwrap_err().code, "auth.failed");
        assert!(!s.holds_master_key());
        assert_eq!(f.failed_in_file(), 1);
        assert!(f.device.asked().len() == 1, "recovery does not use the device check (only the setup one was asked)");
    }

    #[test]
    fn a_recovery_attempt_while_throttled_does_not_unseal() {
        let f = Fx::new();
        f.device_account();
        // The seal key is wrong: opening the file would answer other_device, the throttle must answer first.
        let mut s = f.session([9; 32], Some(f.hint(5)));
        assert_eq!(s.unlock_recovery("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH").unwrap_err().code, "auth.throttled");
        assert!(!s.holds_master_key());
    }

    #[test]
    fn a_correct_recovery_key_unlocks_a_sealed_device_account_and_lock_seals_it_again() {
        let f = Fx::new();
        let (key, _) = f.device_account();
        let mut s = f.session(KEY, Some(f.hint(0)));
        s.unlock_recovery(&key).unwrap();
        assert!(s.holds_master_key() && s.is_unlocked());
        s.lock(LockReason::User, true);
        assert!(!s.holds_master_key());
    }

    #[test]
    fn a_failed_database_open_seals_the_account_again() {
        let f = Fx::new();
        let (key, _) = f.device_account();
        // A folder where the database file should be: the open fails after the master key was read.
        std::fs::remove_file(f.dir.path().join("kasboek.db")).unwrap();
        std::fs::create_dir(f.dir.path().join("kasboek.db")).unwrap();
        let mut s = f.session(KEY, Some(f.hint(0)));
        assert!(s.unlock_recovery(&key).is_err());
        assert!(!s.holds_master_key() && !s.is_unlocked());
    }

    #[test]
    fn a_start_without_a_hint_does_not_keep_a_device_account_open() {
        let f = Fx::new();
        f.device_account();
        let mut s = f.session(KEY, None);
        assert!(!s.holds_master_key());
        let status = s.status();
        assert_eq!((status.state, status.mode, status.two_factor), ("locked", Some("device"), true));
    }

    #[test]
    fn counted_guesses_that_missed_the_file_survive_the_reseal() {
        let f = Fx::new();
        f.device_account();
        let mut s = f.session(KEY, Some(f.hint(3)));
        // The hint is ahead of the file (3 against 0): the larger count is used and kept.
        assert_eq!(s.unlock(&input(Some("000000"))).unwrap_err().code, "auth.failed");
        assert_eq!(f.failed_in_file(), 4);
        assert!(!s.holds_master_key());
    }
}
