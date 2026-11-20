# kb-session

Account and session logic of the native port: a behaviour-for-behaviour port of `src/core/account.ts`,
`src/main/session.ts`, `src/main/security/account-store.ts` and `src/main/quarantine.ts`. Plan: `docs/rust-port-plan.md`
sections 4, 5 and 10.

| Module | What |
|---|---|
| `account` | AccountData v2 (`password` / `device` mode, slots, vault, attempts, remember-2FA), create, unlock with password / device / recovery, throttle (5 free tries, then 30 * 2^(n-5) s, max 15 min), password change, passwordless switch, new recovery key, 2FA on/off |
| `session` | state machine `setup` / `locked` / `unlocked`, `status()` (same shape and key order as `AuthStatus`), `lock()` (drops and zeroizes master key, vault, DB handle, pending 2FA secret), auto-lock hooks, erase / restore, reauth, adopt |
| `store` | `account.json` `{format:'kasboek-account', version:2, seal:'os'\|'os-native'\|'none', data}` (table below), atomic write (tmp created fresh with mode 0600, fsync of file and folder, rename), size caps read with `take(cap+1)`, refuses to write a device slot without the OS seal (availability is asked once), legacy `keystore.json` (`os:` / `plain:`) |
| `seal` | `OsSeal` trait (`seal_value()` = the `seal` value it writes); `FileSeal` (test seal: AES-256-GCM, `iv \|\| ct \|\| tag`); `Unsupported` (writes `seal:'none'`) |
| `oscrypt` | read-only decoder of Electron `safeStorage` values (Chromium OSCrypt), see below |
| `quarantine` | `erased/<time>/` move, rollback, restore, 30-day purge |
| `device` | `DeviceAuth` trait (Windows Hello / Touch ID), `NoDevice`, `FakeDevice` |
| `password` | the password rules of `src/shared/password.ts` |
| `ops` | the `auth.*` handlers and `register_ops()` |
| `time` | `Clock`, `Rng` (injected), `iso()` / `parse_iso()` = `toISOString()` / `Date.parse` for the app's format |

## Plugging into kb-core

`kb-core` owns `dispatch`; this crate does not depend on it (and it not on this crate's internals). A handler is
`fn(&mut Session<S>, serde_json::Value) -> Result<serde_json::Value, SessionError>`. `ops::register_ops::<S>()` returns
`OpSpec { name, in_contract, mutates, handler }` for each op. `kb-core` wraps `Session<S>` where it keeps its store,
maps `SessionError { code, message }` to its own `AppError`, and takes `session.db()` as the store of `Core` after
`auth.setup` / `auth.unlock` / `auth.unlockRecovery` (and drops it on `auth.lock`; register `Session::on_lock`).
The caller does the steps `ipc.ts` does around the session: localise the default categories after `auth.setup`, run
its after-unlock work after `auth.unlock`. Ops with `in_contract: false` (`auth.exists`, `auth.reauth`, `auth.recover`,
`auth.switchToPasswordless`) are aliases for the Rust UI; keep them out of the table compared with `contract.json`.
The TypeScript has no `auth.device*` ops: the device check runs inside `auth.setup`, `auth.unlock`,
`auth.usePasswordless` and `auth.erase` through the `DeviceAuth` trait.

## Differences from the TypeScript (on purpose)

- A device (passwordless) account is **not OS-unsealed** at start-up or after a lock when `Session::init(Some(Hint))`
  is given the prefs `lastAuth` facts: the Lock screen is drawn from the hint, and the file is opened only after the
  device prompt succeeded (plan section 5, "nothing decrypted before authentication"). `lock()` puts the account
  back in that sealed state, so the master key of the device slot is not kept in memory while locked.
- Whatever way `unlock`, `unlock_recovery`, `setup` or `adopt` ends without an open database (cancelled prompt, wrong 2FA
  code, throttle, failed database open, panic), a device account is sealed again (`Resealing` guard); the recovery key is
  checked against the throttle of the hint before the seal is touched; counted guesses in memory survive the reseal (the
  larger of file and hint is kept). When the file cannot be read again, the account is dropped, not kept open.
- A stale or edited `lastAuth` does not decide the mode: with no device check available, or a password supplied, the real
  mode is read (a password account is opened, a device account stays sealed). The hint is cleared by erase and restore.
- `reauth` needs an unlocked session. `UnlockInput` is not `Clone`; password and code are `Zeroizing`. `totp_begin` returns the
  `otpauth://` URI (it holds the secret) as `Zeroizing<String>`.
- **Hardening the TypeScript lacks:** a remembered-computer date (`remember2fa.until`) more than 30 days ahead is refused, and
  the throttle never waits longer than its own delay when `lastFailedAt` is in the future (clock set back, edited file).
  The parity spec only uses dates the app writes, plus one test that states the difference.
- `kb-session-cli` (the parity driver) is built only with `--features parity` (`required-features`), so `cargo build
  --workspace` never makes it. It takes an optional `lastAuth` hint in the script (and on a `reload` step).
- Synchronous API (call from the worker thread that owns the session); OS prompts are behind traits.
- The QR code of `auth.totpBegin` comes from `Session::set_qr_renderer`; the default is an empty string.
- `op.invalid_input` messages are hand-written, not zod's (the code is equal).
- Key order inside `slots` is fixed (recovery, password, device); fields this version does not know are kept.
- `needsRecoveryAck` does not exist in the TypeScript main process; `setupFlowActive` is renderer state there. Here
  `Session::setup_flow_active()` is set by `setup` and cleared by `end_setup_flow()` and `lock()`.

## account.json on disk

| `seal` | Written by | `data` (base64) | Opened by |
|---|---|---|---|
| `none` | any build without a usable seal (password accounts only) | the plain account JSON | nobody needed |
| `os` | Electron `safeStorage` (Chromium OSCrypt: `v10`/`v11`/Windows `v10`); also the test `FileSeal` (`iv \|\| ct \|\| tag`), which is what the parity spec cross-opens | Electron: see the table below | the configured `OsSeal`. A real native seal refuses an Electron value (`auth.other_device`); `kb-oseal`'s migration is the only way in. |
| `os-native` | the native seals of `kb-oseal` (`OsSeal::seal_value()`), and the migration | `KBD1 \|\| DPAPI blob` (Windows) or `KBK1 \|\| iv \|\| ct \|\| tag` (macOS, Linux) | the configured `OsSeal` |

`os` and `os-native` are read the same way (through the seal); the blob magic, not the value, decides what a seal accepts, so a
native `os` file with `KBD1`/`KBK1` is never mistaken for Electron's. `OsSeal::seal_value()` defaults to `os`; native seals return
`os-native`. `account.electron.json` (the untouched Electron original kept by the migration) is removed after the first
native unlock that also saved the file, and by every saved change (password, recovery key, 2FA, mode, import); erase moves
it into `erased/<time>/` with the rest and restore brings it back (a live file is kept as `.orphaned-<time>`). The store
asks the seal for `available()` until it says yes and then keeps that answer, so a keyring that starts late is used but a
device key is never written readable after it was written sealed.

## Electron `safeStorage` seal (spike G6, offline part)

`seal:'os'` files were written by Electron's `safeStorage.encryptStringAsync`, i.e. Chromium OSCrypt. `oscrypt.rs`
documents and implements the AES layers; getting the OS-held key is the `OsKeyProvider` / `Dpapi` traits:

| OS | Value | Key |
|---|---|---|
| Windows | `v10 \|\| nonce(12) \|\| ct \|\| tag(16)`, AES-256-GCM | `Local State` -> `os_crypt.encrypted_key` = base64(`DPAPI` + DPAPI blob); unprotect (user scope) gives the 32-byte key |
| macOS | `v10 \|\| ct`, AES-128-CBC, PKCS#7, IV 16 x `0x20` | PBKDF2-HMAC-SHA1(Keychain password of "Kasboek Safe Storage", `saltysalt`, 1003, 16) |
| Linux | `v11 \|\| ct`, same cipher | PBKDF2-HMAC-SHA1(keyring password, `saltysalt`, 1, 16); libsecret or kwallet |
| Linux, no keyring | `v10 \|\| ct` | the fixed password `peanuts` (the `basic_text` backend; `keyProtection` says `weak`) |

Tested with fixtures made by Node's crypto (`rust/parity/fixtures-session/gen-oscrypt.mjs` -> `oscrypt.json`): all four
layouts, a stand-in DPAPI, wrong key, flipped bit, truncation, unknown prefix. **Not verified offline:** that Electron 45's
*async* API keeps exactly these prefixes and layouts, the real DPAPI / Keychain / Secret Service calls, and the exact
Keychain / keyring item names. The first real file from each OS decides. Re-sealing as `seal:'os-native'` and keeping
`account.electron.json` (plan section 4) is done by `kb-oseal`'s migration; this crate reads the result.

## Tests

- `cargo test -p kb-session`: unit tests, `tests/session.rs` (27 scenarios on a real encrypted database), `tests/oscrypt.rs`. The reseal tests
  (`session.rs`, `mod tests`) check that no master key can be fetched from the `Session` after each failure path.
- `npx vitest run --config rust/parity/vitest.config.ts rust/parity/session.spec.ts` (after `cargo build -p kb-session --features parity`):
  runs the TypeScript session (Electron, device check and clock mocked) and `kb-session-cli` on the same scripts, compares
  every status and error, the decrypted `account.json` structures and cross-opens files in both directions.
