# Kasboek for Android and iPhone: concept

Status: concept only. No code yet. The desktop app comes first.

## Goals
- One app for Android and iPhone, with editing.
- No paid Apple developer account.
- The same privacy as the desktop: the data is encrypted on the device, and there is no Kasboek server.
- The phone is one more device in the existing folder sync.

## Not on the phone (desktop only)
- CSV import and the CSV Check.
- The rules editor, transfer pairing, split transactions.
- Net worth, the year report, exports.
- MCP and the tray.
- The assistant (maybe later, with the person's own API key or a local model on their network).

## On the phone
| Area | What |
|---|---|
| Overview | This month, left to spend, alerts, the month picker |
| Transactions | List, search, filter; add (cash), edit, delete; categorise, rename, notes |
| Budgets | View, set and change a budget |
| Goals | View, add, update |
| Fixed costs | View what is paid, due and late |
| Settings | Language, formats, unlock with Face ID or a fingerprint, the sync folder, lock timeout |

## How it is built
- **Capacitor** wraps the existing React renderer as a native app on both platforms. Screens get a phone layout (bottom tabs, one column), not a rewrite.
- **The core logic** (`src/core`: finance, budgets, recurring, alerts, goals, sync engine, migrations) is reused as is. It depends on two Node-only things that need a replacement:
  - `better-sqlite3-multiple-ciphers`: replaced by a database adapter with the same synchronous API. First choice: the SQLite3MultipleCiphers WebAssembly build, running in a worker with storage in the origin-private file system (OPFS). It uses the same `chacha20` cipher, so backups and keys work the same.
  - `node:crypto`: replaced by Web Crypto and `hash-wasm` (already a dependency).
- **The desktop main process** (`src/main`) is not used. The phone gets a small host layer instead: the ops from `src/core/ops.ts`, plus phone-specific code for the folder, unlocking and the lifecycle.

### Risk to test first
The core expects a database that answers synchronously. If the WebAssembly build cannot provide that inside a worker with acceptable speed (target: lists and summaries under 150 ms with 30,000 transactions on a mid-range phone), the fallback is a native SQLite plugin with SQLCipher and an async adapter, which means making the core async. That is the biggest unknown and the reason for the proof of concept.

## Sync
- The engine (`src/core/sync.ts`) already merges field by field with hybrid logical clocks, and needs no server. The phone gets its own device id and takes part like a computer.
- **Folder access:**
  - iPhone: the system document picker (iCloud Drive, or another app that provides files), with a security-scoped bookmark so the folder is remembered.
  - Android: the Storage Access Framework (`ACTION_OPEN_DOCUMENT_TREE`) with a persisted permission (Google Drive, OneDrive, a local folder).
- **When:** on opening the app, on returning to it, and after each change (debounced). There is no background sync. Both systems limit it, and it is not needed.
- **Versions:** the phone and the desktop must have the same schema version to sync. The phone refuses to sync with a newer schema and asks for an update; an older desktop already ignores unknown columns.

## Security
- The database key is wrapped by the system's secure storage (iOS Keychain, Android Keystore), opened with Face ID or a fingerprint, and the password as a fallback.
- Lock when the app goes to the background (after a short, configurable delay).
- Hide the content in the app switcher (iOS: cover view; Android: `FLAG_SECURE`).
- No analytics, no crash reporting to outside services.

## Distribution without paying
- **Android:** an APK built by GitHub Actions and attached to the release. Installed directly ("install unknown apps").
- **iPhone:** GitHub Actions (macOS runner) builds an unsigned `.ipa`. The person installs it with **SideStore** (or AltStore) and a free Apple ID.
  - It has to be re-signed every 7 days. SideStore can do this on the phone over Wi-Fi.
  - At most 3 sideloaded apps per free Apple ID.
  - A computer is needed once, to set up SideStore.
  - An expired signature stops the app from opening until it is refreshed. The data should stay (to verify).
  - Check SideStore's current state before relying on it; Apple changes its rules often.
- Later, with a paid account, the same app can go to the App Store and TestFlight without a rebuild.

## Phases
1. **Proof of concept (Android):** open an encrypted test database, run the core's summaries, and sync with the desktop through a folder. Measure speed. Decide between WebAssembly and a native plugin.
2. **Phone layout:** the screens in the table above, the unlock, the lock on background.
3. **Sync settings** and the first-time setup (choose the folder, join with the password).
4. **iPhone build** in GitHub Actions, sideloaded with SideStore.
5. **Release:** the APK and IPA attached to the GitHub release, with installation steps.

## Open questions
- Which cloud folder does the sync use? It decides how well step 3 works on each phone.
- Should the phone keep the full history, or only the last 2–3 years to stay small?
- Should the phone be able to change budgets and goals, or only transactions? (Current plan: all three.)
