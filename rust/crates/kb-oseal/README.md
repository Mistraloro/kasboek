# kb-oseal

The operating system seal around `account.json` for the native app: real `kb_session::seal::OsSeal` implementations per OS
and the key material needed to read, and migrate from, what Electron's `safeStorage` wrote. Plan: `docs/rust-port-plan.md`
sections 4 and 10.

| OS | Seal | Blob | Key |
|---|---|---|---|
| Windows | `DpapiSeal<SystemDpapi>` (`CryptProtectData`, user scope, no UI, entropy `kasboek:oseal:dpapi:v1`) | `KBD1 \|\| DPAPI blob` | the user's DPAPI master key |
| macOS | `WrapKeySeal<MacKeychain>` | `KBK1 \|\| iv(12) \|\| ct \|\| tag(16)`, AES-256-GCM, AAD `kasboek:oseal:wrap:v1` | random 32 bytes in Keychain item `Kasboek Wrap Key` / `Kasboek` |
| Linux | `WrapKeySeal<SecretService>` (`oo7`, blocking, async-io runtime) | as macOS | Secret Service item `service=Kasboek`, `account=wrap-key` |
| Linux, no keyring | the same `WrapKeySeal`, `available() == false` (asked again later) | | account.json is `seal:'none'`, which kb-session allows for password accounts only |

- **The app calls `select_os_seal_for(data_dir)`** and passes the result to `kb_session::Config::new`; `select_os_seal()` is the
  same without the stale-key check. Native seals write `seal:'os-native'` (`OsSeal::seal_value`); `os` stays Electron's
  (on-disk table: `kb-session/README.md`). `FileSeal` stays in kb-session (tests only).
- Wrap key: created only when absent, never replaced (Keychain `SecItemAdd`; Secret Service creates, then the oldest item wins and a
  loser deletes only its own; in-process mutex). When the data folder has no native account (nor an erased copy), the first
  `seal` deletes a wrap key already in the store and makes a fresh one (`WrapKeySeal::replacing_stale_key`). A damaged account.json
  counts as native: the key is kept. `usable()` never prompts (a locked keyring is still "usable") and a "no" is not remembered.
- OS calls are behind `DpapiApi` and `SecretStore`; unit tests use fakes, so they run on any OS.
- `legacy`: `electron_key_provider(data_dir)` (Windows: `Local State` + DPAPI; macOS: Keychain `Kasboek Safe Storage` /
  `Kasboek`; Linux: Secret Service item labelled `Kasboek Safe Storage`, `v10` needs none),
  `open_electron_account_json(data_dir)`, `plan_migration(data_dir, &seal)` -> `MigrationPlan::apply()`: writes
  `seal:'os-native'`, keeps the original as `account.electron.json` (never overwritten), refuses a file that changed, reads
  account.json capped. A native `os` file (`KBD1`/`KBK1`) plans nothing. kb-session deletes the backup later.
- Blocking calls: use them from the worker thread that owns the session. Secrets are `Zeroizing`; nothing prints them.

`tests/real_os.rs` runs the real OS calls on the matching OS (not `#[ignore]`d). Windows needs nothing. macOS uses its own
Keychain service name and skips with a message when the login keychain is locked. Linux tests the no-keyring answer and
the keyring-free `v10` path; with a Secret Service running it also tests create-if-absent and stale-key replacement on its own item
(`account=wrap-key-test-...`). Keystore tests skip with a message when no keyring is reachable.

Not verified without the real OS: see the "kb-oseal" block in section 10 of the plan.
