//! The local account: how the master key is unlocked and what it protects. Port of src/core/account.ts.
//!
//! ```text
//! password -Argon2id-+
//! recovery key ------+-> master key -> vault { database key, 2FA secret }
//! device (OS) -------+
//! ```
//!
//! Pure logic: no files, time and randomness come in through [`Crypto`]. Functions take the account by reference and
//! return the new one, as the TypeScript does, so the caller saves it. Field order of the structs is the key order
//! of `JSON.stringify` in the app.
use crate::error::{SessionError, SessionResult};
use crate::time::{iso, parse_iso, random_array, Clock, Rng};
use hmac::{Hmac, Mac};
use kb_crypto::aead::Sealed;
use kb_crypto::encoding::{base32_encode, base64_decode, base64_encode};
use kb_crypto::recovery::normalize_recovery_key;
use kb_crypto::slot::{make_slot_with, open_slot, slot_needs_upgrade, Argon2Cost, Slot, SlotKind, PASSWORD_KDF};
use kb_crypto::totp::verify_totp;
use kb_crypto::vault::{open_vault, seal_vault, Totp, Vault};
use kb_crypto::Master;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;
use std::fmt;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const REMEMBER_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;
const FREE_ATTEMPTS: u64 = 5;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Password,
    Device,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Device => "device",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct Slots {
    pub recovery: Slot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<Slot>,
    /// Passwordless only: the master key itself (base64), protected solely by the device seal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<Zeroizing<String>>,
}

/// The device slot holds the master key: it is never printed.
impl fmt::Debug for Slots {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Slots").field("password", &self.password.is_some()).field("device", &self.device.is_some()).finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Attempts {
    pub failed: u64,
    #[serde(rename = "lastFailedAt")]
    pub last_failed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Remember {
    pub until: String,
    pub mac: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct AccountData {
    pub version: u64,
    pub mode: AuthMode,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "twoFactor")]
    pub two_factor: bool,
    pub slots: Slots,
    pub vault: Sealed,
    pub attempts: Attempts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember2fa: Option<Remember>,
    /// Fields of a newer version, kept so saving does not drop them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Values of `extra` (fields of a newer version) are never printed, as with the vault.
impl fmt::Debug for AccountData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccountData")
            .field("version", &self.version)
            .field("mode", &self.mode)
            .field("created_at", &self.created_at)
            .field("two_factor", &self.two_factor)
            .field("slots", &self.slots)
            .field("vault", &self.vault)
            .field("attempts", &self.attempts)
            .field("remember2fa", &self.remember2fa)
            .field("extra", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// What the account functions need from the outside.
pub struct Crypto<'a> {
    pub clock: &'a dyn Clock,
    pub rng: &'a dyn Rng,
    /// Argon2id cost for new password slots (tests lower it).
    pub cost: Argon2Cost,
}

impl<'a> Crypto<'a> {
    pub fn new(clock: &'a dyn Clock, rng: &'a dyn Rng) -> Self {
        Self { clock, rng, cost: PASSWORD_KDF }
    }
}

fn remember_mac(master: &[u8; 32], until: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(master).expect("HMAC takes keys of any length");
    mac.update(format!("kasboek:remember2fa:{until}").as_bytes());
    base64_encode(&mac.finalize().into_bytes())
}

/// Latest `until` that is believable: a remembered computer is never granted for longer than [`REMEMBER_DAYS`].
fn remember_limit(now_ms: i64) -> i64 {
    now_ms.saturating_add(REMEMBER_DAYS * DAY_MS)
}

/// True if the 2FA code may be skipped on this computer right now (checked only after the master key is known).
///
/// Hardening the TypeScript lacks, on purpose: an `until` more than 30 days ahead is refused (an edited account file with
/// a far-future date would otherwise skip the code for good). The parity spec only uses dates the app itself writes.
pub fn remember_valid(account: &AccountData, master: &[u8; 32], now_ms: i64) -> bool {
    let Some(r) = &account.remember2fa else { return false };
    // `Date.parse(...) <= now` is false for an unparsable date in JavaScript, so only a real date outside the window refuses here.
    if !account.two_factor || parse_iso(&r.until).is_some_and(|t| t <= now_ms || t > remember_limit(now_ms)) {
        return false;
    }
    let expected = remember_mac(master, &r.until);
    expected.len() == r.mac.len() && bool::from(expected.as_bytes().ct_eq(r.mac.as_bytes()))
}

/// Whether the lock screen can leave out the code field (unverified: the real check happens on unlock).
pub fn remembered_until(account: &AccountData, now_ms: i64) -> Option<String> {
    let r = account.remember2fa.as_ref()?;
    (account.two_factor && parse_iso(&r.until).is_some_and(|t| t > now_ms && t <= remember_limit(now_ms))).then(|| r.until.clone())
}

pub fn forget_remembered(mut account: AccountData) -> AccountData {
    account.remember2fa = None;
    account
}

fn remembered(mut account: AccountData, master: &[u8; 32], now_ms: i64) -> AccountData {
    let until = iso(remember_limit(now_ms));
    let mac = remember_mac(master, &until);
    account.remember2fa = Some(Remember { until, mac });
    account
}

pub struct Unlocked {
    pub master: Master,
    pub vault: Vault,
}

pub struct Created {
    pub account: AccountData,
    pub master: Master,
    pub vault: Vault,
    pub recovery_key: Zeroizing<String>,
}

pub fn new_recovery_key(rng: &dyn Rng) -> Zeroizing<String> {
    let chars = Zeroizing::new(base32_encode(&*random_array::<20>(rng)));
    Zeroizing::new(chars.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("base32 is ASCII")).collect::<Vec<_>>().join("-"))
}

pub fn new_totp_secret(rng: &dyn Rng) -> Zeroizing<String> {
    Zeroizing::new(base32_encode(&*random_array::<20>(rng)))
}

pub fn create_account(c: &Crypto, mode: AuthMode, password: Option<&str>, db_key: &str) -> SessionResult<Created> {
    let master: Master = random_array::<32>(c.rng);
    let recovery_key = new_recovery_key(c.rng);
    let vault = Vault { db_key: Zeroizing::new(db_key.to_owned()), totp: None, extra: Map::new() };
    let password = password.filter(|p| !p.is_empty());
    if mode == AuthMode::Password && password.is_none() {
        return Err(SessionError::new("auth.password_required", "Choose a password."));
    }
    let recovery = make_slot_with(&master, &Zeroizing::new(normalize_recovery_key(&recovery_key)), SlotKind::Recovery, c.cost)?;
    let (password_slot, device) = match (mode, password) {
        (AuthMode::Password, Some(p)) => (Some(make_slot_with(&master, p, SlotKind::Password, c.cost)?), None),
        _ => (None, Some(Zeroizing::new(base64_encode(&*master)))),
    };
    let account = AccountData {
        version: 2,
        mode,
        created_at: iso(c.clock.now_ms()),
        two_factor: false,
        slots: Slots { recovery, password: password_slot, device },
        vault: seal_vault(&master, &vault),
        attempts: Attempts { failed: 0, last_failed_at: None },
        remember2fa: None,
        extra: Map::new(),
    };
    Ok(Created { account, master, vault, recovery_key })
}

/* ---------- Throttling (app-enforced; the KDF cost is the real barrier) ---------- */

/// Seconds to wait before the next attempt is allowed: 5 free tries, then 30 * 2^(n-5) seconds, at most 15 minutes.
pub fn throttle_seconds(account: &AccountData, now_ms: i64) -> u64 {
    throttle_for(&account.attempts, now_ms)
}

pub fn throttle_for(attempts: &Attempts, now_ms: i64) -> u64 {
    let failed = attempts.failed;
    let Some(last) = attempts.last_failed_at.as_deref().and_then(parse_iso) else { return 0 };
    if failed < FREE_ATTEMPTS {
        return 0;
    }
    let exp = failed - FREE_ATTEMPTS;
    let delay: i64 = if exp >= 6 { 15 * 60 } else { (30i64 << exp).min(15 * 60) };
    // Hardening the TypeScript lacks, on purpose: a `lastFailedAt` in the future (clock set back, edited file) never waits
    // longer than the delay itself.
    let left_ms = last.saturating_add(delay * 1000).saturating_sub(now_ms).min(delay * 1000);
    if left_ms <= 0 {
        0
    } else {
        ((left_ms + 999) / 1000) as u64
    }
}

pub fn check_throttle(account: &AccountData, now_ms: i64) -> SessionResult<()> {
    check_throttle_for(&account.attempts, now_ms)
}

pub fn check_throttle_for(attempts: &Attempts, now_ms: i64) -> SessionResult<()> {
    let wait = throttle_for(attempts, now_ms);
    if wait > 0 {
        return Err(SessionError::new("auth.throttled", format!("Too many attempts. Try again in {wait} seconds.")));
    }
    Ok(())
}

pub fn record_failure(account: &AccountData, now_ms: i64) -> AccountData {
    let mut next = account.clone();
    next.attempts = Attempts { failed: account.attempts.failed + 1, last_failed_at: Some(iso(now_ms)) };
    next
}

fn cleared(mut account: AccountData) -> AccountData {
    account.attempts = Attempts { failed: 0, last_failed_at: None };
    account
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UnlockOptions {
    /// Remember this computer for 30 days after a correct 2FA code.
    pub remember: bool,
}

pub enum Outcome {
    Ok {
        unlocked: Unlocked,
        account: AccountData,
    },
    /// The account with the failure recorded, for the caller to save. The error never says which factor was wrong.
    Failed {
        account: AccountData,
    },
}

fn verify_second_factor(vault: &Vault, code: Option<&str>, now_ms: i64) -> SessionResult<Option<Vault>> {
    let Some(totp) = &vault.totp else {
        return Err(SessionError::corrupt("Two-factor settings are missing."));
    };
    let step = match code {
        Some(code) => verify_totp(&totp.secret, code, totp.last_step, now_ms as f64 / 1000.0)?,
        None => None,
    };
    Ok(step.map(|step| {
        let mut next = vault.clone();
        next.totp = Some(Totp { secret: totp.secret.clone(), last_step: step });
        next
    }))
}

fn second_factor(
    account: &AccountData,
    master: &[u8; 32],
    code: Option<&str>,
    opts: UnlockOptions,
    now_ms: i64,
) -> SessionResult<Option<(Vault, AccountData)>> {
    let vault = open_vault(master, &account.vault)?;
    if !account.two_factor {
        return Ok(Some((vault, account.clone())));
    }
    if code.is_none() && remember_valid(account, master, now_ms) {
        return Ok(Some((vault, account.clone())));
    }
    let Some(checked) = verify_second_factor(&vault, code, now_ms)? else { return Ok(None) };
    let account = if opts.remember { remembered(account.clone(), master, now_ms) } else { account.clone() };
    Ok(Some((checked, account)))
}

fn succeed(account: AccountData, master: Master, vault: Vault) -> Outcome {
    let mut account = cleared(account);
    account.vault = seal_vault(&master, &vault);
    Outcome::Ok { unlocked: Unlocked { master, vault }, account }
}

/// Unlocks with the password (and the 2FA code if enabled).
pub fn unlock_with_password(
    c: &Crypto,
    account: &AccountData,
    password: &str,
    code: Option<&str>,
    opts: UnlockOptions,
) -> SessionResult<Outcome> {
    let now = c.clock.now_ms();
    let code = code.filter(|s| !s.is_empty());
    check_throttle(account, now)?;
    let Some(slot) = account.slots.password.as_ref().filter(|_| account.mode == AuthMode::Password) else {
        return Err(SessionError::new("auth.wrong_mode", "This account uses Windows Hello or Touch ID."));
    };
    // The Argon2id library of the app (hash-wasm) throws on an empty password, which is not an AppError: the person sees
    // `op.failed` and no attempt is counted. Same here.
    if password.is_empty() && matches!(slot.kdf, kb_crypto::slot::Kdf::Argon2id { .. }) {
        return Err(SessionError::failed());
    }
    let Some(master) = open_slot(slot, password, SlotKind::Password)? else {
        return Ok(Outcome::Failed { account: record_failure(account, now) });
    };
    let Some((vault, mut next)) = second_factor(account, &master, code, opts, now)? else {
        return Ok(Outcome::Failed { account: record_failure(account, now) });
    };
    // Re-make an older scrypt slot with Argon2id now that the password is known.
    if slot_needs_upgrade(slot) {
        next.slots.password = Some(make_slot_with(&master, password, SlotKind::Password, c.cost)?);
    }
    Ok(succeed(next, master, vault))
}

/// Passwordless: the caller has already verified the person with Windows Hello / Touch ID.
pub fn unlock_with_device(c: &Crypto, account: &AccountData, code: Option<&str>, opts: UnlockOptions) -> SessionResult<Outcome> {
    let now = c.clock.now_ms();
    let code = code.filter(|s| !s.is_empty());
    check_throttle(account, now)?;
    let Some(device) = account.slots.device.as_ref().filter(|_| account.mode == AuthMode::Device) else {
        return Err(SessionError::new("auth.wrong_mode", "This account uses a password."));
    };
    let master = master_from_device_slot(device)?;
    let Some((vault, next)) = second_factor(account, &master, code, opts, now)? else {
        return Ok(Outcome::Failed { account: record_failure(account, now) });
    };
    Ok(succeed(next, master, vault))
}

fn master_from_device_slot(device: &str) -> SessionResult<Master> {
    let bytes = Zeroizing::new(base64_decode(device).ok_or_else(|| SessionError::corrupt("The account data is damaged."))?);
    let master: [u8; 32] = bytes.as_slice().try_into().map_err(|_| SessionError::corrupt("The account data is damaged."))?;
    Ok(Zeroizing::new(master))
}

/// The recovery key replaces both the password and the 2FA code.
pub fn unlock_with_recovery(c: &Crypto, account: &AccountData, recovery_key: &str) -> SessionResult<Outcome> {
    let now = c.clock.now_ms();
    check_throttle(account, now)?;
    let secret = Zeroizing::new(normalize_recovery_key(recovery_key));
    let Some(master) = open_slot(&account.slots.recovery, &secret, SlotKind::Recovery)? else {
        return Ok(Outcome::Failed { account: record_failure(account, now) });
    };
    let vault = open_vault(&master, &account.vault)?;
    Ok(succeed(account.clone(), master, vault))
}

/* ---------- Changes (all require an unlocked master key) ---------- */

pub fn set_password(c: &Crypto, account: &AccountData, master: &[u8; 32], password: &str) -> SessionResult<AccountData> {
    let mut next = forget_remembered(account.clone());
    next.mode = AuthMode::Password;
    next.slots.device = None;
    next.slots.password = Some(make_slot_with(master, password, SlotKind::Password, c.cost)?);
    Ok(next)
}

pub fn set_passwordless(account: &AccountData, master: &[u8; 32]) -> AccountData {
    let mut next = forget_remembered(account.clone());
    next.mode = AuthMode::Device;
    next.slots.password = None;
    next.slots.device = Some(Zeroizing::new(base64_encode(master)));
    next
}

pub fn rotate_recovery_key(c: &Crypto, account: &AccountData, master: &[u8; 32]) -> SessionResult<(AccountData, Zeroizing<String>)> {
    let recovery_key = new_recovery_key(c.rng);
    let mut next = account.clone();
    next.slots.recovery = make_slot_with(master, &Zeroizing::new(normalize_recovery_key(&recovery_key)), SlotKind::Recovery, c.cost)?;
    Ok((next, recovery_key))
}

/// Switches 2FA on (`Some`) or off (`None`) and forgets the remembered computer.
pub fn set_two_factor(account: &AccountData, master: &[u8; 32], vault: &Vault, totp: Option<Totp>) -> (AccountData, Vault) {
    let mut vault = vault.clone();
    vault.totp = totp;
    let mut next = forget_remembered(account.clone());
    next.two_factor = vault.totp.is_some();
    next.vault = seal_vault(master, &vault);
    (next, vault)
}

pub fn store_vault(account: &AccountData, master: &[u8; 32], vault: &Vault) -> AccountData {
    let mut next = account.clone();
    next.vault = seal_vault(master, vault);
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{ManualClock, SeededRng};

    const NOW: i64 = 1_790_000_000_000;

    fn two_factor_account() -> (AccountData, Master) {
        let (clock, rng) = (ManualClock::new(NOW), SeededRng::new(9));
        let c = Crypto { clock: &clock, rng: &rng, cost: Argon2Cost { m: 64, t: 1, p: 1 } };
        let created = create_account(&c, AuthMode::Password, Some("violet-Harbor-83-lantern"), &"ab".repeat(32)).unwrap();
        let mut account = created.account;
        account.two_factor = true;
        (account, created.master)
    }

    fn remembered_at(account: &AccountData, master: &[u8; 32], until_ms: i64) -> AccountData {
        let until = iso(until_ms);
        let mut next = account.clone();
        next.remember2fa = Some(Remember { mac: remember_mac(master, &until), until });
        next
    }

    #[test]
    fn a_remembered_computer_is_valid_for_at_most_30_days_ahead() {
        let (account, master) = two_factor_account();
        let limit = NOW + REMEMBER_DAYS * DAY_MS;
        let ok = remembered_at(&account, &master, limit);
        assert!(remember_valid(&ok, &master, NOW) && remembered_until(&ok, NOW).is_some());
        // Correctly signed, but further ahead than the app ever writes: refused, also on the lock screen.
        let far = remembered_at(&account, &master, limit + 1);
        assert!(!remember_valid(&far, &master, NOW) && remembered_until(&far, NOW).is_none());
        let forever = remembered_at(&account, &master, 253_370_764_800_000);
        assert!(!remember_valid(&forever, &master, NOW));
        // Past and present dates stay refused, as in the TypeScript.
        assert!(!remember_valid(&remembered_at(&account, &master, NOW), &master, NOW));
        assert!(!remember_valid(&remembered_at(&account, &master, NOW - 1), &master, NOW));
        // A date the app wrote itself (now + 30 days at writing time) is valid right then and a day later.
        let own = remembered(account.clone(), &master, NOW);
        assert!(remember_valid(&own, &master, NOW) && remember_valid(&own, &master, NOW + DAY_MS));
    }

    #[test]
    fn a_last_failure_in_the_future_never_waits_longer_than_the_delay() {
        let at = |failed: u64, last: i64| Attempts { failed, last_failed_at: Some(iso(last)) };
        assert_eq!(throttle_for(&at(5, NOW), NOW), 30);
        assert_eq!(throttle_for(&at(5, NOW + 10 * 365 * DAY_MS), NOW), 30);
        assert_eq!(throttle_for(&at(11, NOW + 86_400_000), NOW), 900);
        assert_eq!(throttle_for(&at(500, NOW + 365 * DAY_MS), NOW), 900);
        // The ordinary edges are as before.
        assert_eq!(throttle_for(&at(4, NOW), NOW), 0);
        assert_eq!(throttle_for(&at(5, NOW - 30_000), NOW), 0);
        assert_eq!(throttle_for(&at(5, NOW - 29_999), NOW), 1);
        assert_eq!(throttle_for(&Attempts { failed: 9, last_failed_at: None }, NOW), 0);
    }

    #[test]
    fn debug_output_shows_no_values_of_newer_fields_or_the_device_key() {
        let (mut account, _) = two_factor_account();
        account.extra.insert("future".into(), Value::String("secret-value".into()));
        account.slots.device = Some(Zeroizing::new("master-key-text".into()));
        let text = format!("{account:?}");
        assert!(text.contains("future") && !text.contains("secret-value") && !text.contains("master-key-text"));
    }
}
