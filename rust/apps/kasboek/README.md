# kasboek: the native app

The first real screens of the native Kasboek (plan: `docs/rust-port-plan.md`, sections 5 and 10): Lock, Setup (skeleton), the
loading view and the Overview inside the app shell, built from the `kb-ui` design system, wired through the `AppService` trait
of `kb-service` so that they run on fixtures now and on `kb-core` / `kb-session` later. Slint 1.19, software renderer.

## Run

```sh
cargo run --release -p kasboek -- --data-dir DIR     # the real service: Setup on an empty folder, Lock when an account exists
cargo run --release -p kasboek                       # the real service when the Electron data folder exists and the OS can seal it (else a message), else the fixtures
cargo run --release -p kasboek -- --service fixture  # fixture service, Lock screen; password: correct horse battery 12
cargo run --release -p kasboek -- --state unlocked   # straight to the Overview
cargo run --release -p kasboek -- --state setup      # the Setup screen
cargo run --release -p kasboek --features dev-start -- --mode device --fake-device   # the "Unlock with Windows Hello" button (answers "verified" without the OS)
cargo run --release -p kasboek -- --service core-temp --state unlocked   # kb-core on a seeded temporary database
```

Options: `--theme light|dark|system`, `--lang en|nl|fr|de|es|es-419|pt-PT|pt-BR`, `--scale N`, `--today YYYY-MM-DD`,
`--slow-steps MS` (pause between the simulated loading steps, to see the loading view), `--data-dir DIR` (real service: the data
folder, or `KASBOEK_DATA_DIR`; default the Electron `userData` folder (`%APPDATA%\Kasboek`, `~/Library/Application Support/Kasboek`,
`$XDG_CONFIG_HOME/Kasboek`), opened by default only when it exists and the OS key store can seal its account file, else the app says so and stops; the folder is created private (0700 on Unix); with no
home/config folder known the app says so and stops, it never falls back to a temporary folder; fixtures: prefs only, default `<config>/kasboek-native-dev`), `--log FILE`, `--exit-after-ms N`, `--exit-after-first-frame`,
`--inset PX` (room for window controls drawn into the top bar; 12 by default, Electron uses 148).
Development flags, only in a build with the cargo feature `dev-start` (off by default, so not in release builds, which exit 2 with a message when given one (`tests/dev_flags.rs`); the CI build and
`tools/startup-test-core.sh` use it): `--fake-device`, and `--demo-setup` (creates or unlocks the account with the password of
`KASBOEK_DEMO_PASSWORD`, which is removed from the environment at once and held in a wiped-on-drop value).
`prefs.json` is written by the service only (`kb_service::update_prefs_key`; the app reads it for the first frame): a file that
can't be read is moved to `prefs.json.bad`, not overwritten; writes go through a new 0600 temporary file and only happen when a value changed.
`lastAuth` also keeps the count of wrong tries, so that the throttle holds before a sealed account file is opened.
`startup.log` is written next to the binary (previous run: `startup.prev.log`) with the milestones of plan section 5.

## Screenshots and checks

```sh
kasboek shot overview light out.png --today 2026-11-15          # 1440x900 at scale 2, like the Electron stills
kasboek shot lock-password|lock-device|lock-error|lock-busy|setup|setup-password|setup-recovery|loading|overview light|dark out.png
python tools/parity.py <shots> <electron-stills>   # pixel diff and landmark offsets against docs/screenshots of the release branch
tools/a11y-dump.sh target/release/kasboek [--state unlocked]    # AT-SPI tree (PYATSPI_PYTHON=/usr/bin/python3.12 where gi is for 3.12)
tools/startup-test.sh target/release/kasboek                     # CI: window opens, milestones logged, clean exit
tools/startup-test-core.sh target/release/kasboek                # CI: real service, account created in a temp folder, unlocked first frame logged
tools/a11y-flow.sh target/release/kasboek                        # drives Setup, Lock, Security, Accounts through AT-SPI (PYATSPI_PYTHON as above)
node tools/gen-fixtures.mjs <data.mjs>             # fixtures/household.json from scripts/screenshots/data.mjs of the release branch
```

## Layout

| Path | What |
|---|---|
| `ui/` | `app.slint` (window), `state.slint` (the globals Rust talks to), `auth.slint` (Lock, Setup, loading), `shell.slint` (sidebar, top bar, placeholder pages), `overview.slint` (Overview and Suggestions), `parts.slint` |
| `src/app.rs` | the controller: service calls on worker threads, results on the UI thread; unlock, throttle countdown, 180 ms / 300 ms loading gate, lock |
| `src/view.rs` | what the Overview asks the core for and how it reaches the screen (texts from `kb-i18n`, money from `format.rs`) |
| `src/loading.rs` | real progress shares per step and the loading gate rules (tested) |
| `src/prefs.rs` | prefs.json as far as the first frame needs it: theme, language, `lastAuth` cache |
| `src/security.rs`, `src/accounts.rs`, `src/setup_rules.rs` | Settings -> Security, the Accounts developer preview, the recovery-key and 2FA rules of `setup-rules.ts` |
| `ui/panels.slint`, `ui/pages.slint` | recovery key and 2FA panels (shared by Setup and Security), the Security and Accounts pages |
| `src/log.rs`, `src/device.rs` | startup.log and the Hello / Touch ID prompt, moved here from the UI spike |
| `src/titlebar.rs` | Windows 11 title bar colour (DWM), system theme detection |
| `fixtures/household.json` | the invented household of the release screenshots (accounts, month summaries, budgets, tips) |

## Not ported yet / stubbed

- Pages other than the Overview are placeholder cards ("Not available in this version yet"); the assistant panel is a note.
  Buttons whose operations do not exist (Review, Get tips, Not useful / Hide) show a toast naming the operation.
- Real now (`--service core`): accounts and login through `kb-session` (setup, unlock, lock, throttle, 2FA, recovery key, change of password,
  erase), the database opens on unlock and closes on lock, auto-lock (idle minutes of the preferences) and the Overview on real ops. Setup: password with
  meter, passwordless, recovery key with the typed confirmation, 2FA step with QR, import option disabled ("not available yet"). Settings -> Security is
  minimal (password, passwordless, new recovery key, 2FA). The Accounts page is a **developer preview** to add an account and a transaction.
- OS seal: the real service uses `kb_oseal::select_os_seal_for` (DPAPI, Keychain wrap key, Secret Service). At start, before the account file is read, an
  Electron-sealed `account.json` is moved to `seal: 'os-native'` (`kb_oseal::plan_migration`); the original stays as `account.electron.json` until the first
  native unlock that saved the file. A failure shows on the Lock screen ("Kasboek could not take over the data of the Electron app: ...") and changes nothing.
  Without a key store (Linux, no Secret Service) `account.json` is `seal: 'none'` and passwordless is refused. Tests use fake `OsSeal` / `DeviceAuth`; the
  real OS calls are not run by the app tests (`kb-oseal/tests/real_os.rs` does that where a keyring exists).
- Stubbed: lock on system lock/suspend and the OS idle time (`OsEvents` stub, TODO:
  real implementations per OS; the timer counts service calls and navigation), default categories
  are not localised after setup, no clipboard copy of the recovery key, no "choose a new password" screen after a recovery unlock, migrations are reported as one step.
- The fixture service (`--service fixture`, screenshots) still simulates login. Pages other than Overview, Accounts and Settings are placeholder cards; buttons
  whose operations do not exist (Review, Get tips, Not useful / Hide) show a toast naming the operation.
- The window is shown with `show()`: Slint 1.19's software renderer has no first-paint hook, so "first frame" is the first
  timer tick after `show()` (an upper bound), as in the spike. The window is not created hidden.
- Month names are English in all languages. The assistant panel, the Tour and Welcome are not built.
- macOS keeps the standard title bar (a transparent one needs winit window attributes behind an unstable Slint feature).
- Account numbers show only while the eye in the Accounts header is held (and are masked in the accessibility tree); the
  renderer shows none there.

## Linux: fontconfig

The app embeds its fonts, but Slint 1.19 always pulls in `fontique` (shared font collection), which links `libfontconfig` on
Linux; no Slint feature switches that off (only `fontconfig-dlopen` on `i-slint-common`, which Slint does not expose). So building
needs `libfontconfig1-dev` and the binary needs `libfontconfig1` at run time (see the `Linux packages` step in the workflows).

## Needs Windows or macOS to confirm

Windows Hello and Touch ID prompts, the DWM title bar colours, Narrator / VoiceOver, IME and dead keys in the fields, fonts under
DirectWrite / CoreText, the system theme detection, and the build of `titlebar.rs` and `device.rs` themselves (written without a
compiler for those targets; `.github/workflows/rust-app.yml` is their first build).
