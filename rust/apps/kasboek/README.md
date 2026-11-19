# kasboek: the native app

The first real screens of the native Kasboek (plan: `docs/rust-port-plan.md`, sections 5 and 10): Lock, Setup (skeleton), the
loading view and the Overview inside the app shell, built from the `kb-ui` design system, wired through the `AppService` trait
of `kb-service` so that they run on fixtures now and on `kb-core` / `kb-session` later. Slint 1.19, software renderer.

## Run

```sh
cargo run --release -p kasboek                       # fixture service, Lock screen; password: correct horse battery 12
cargo run --release -p kasboek -- --state unlocked   # straight to the Overview
cargo run --release -p kasboek -- --state setup      # the Setup screen
cargo run --release -p kasboek -- --mode device --fake-device   # the "Unlock with Windows Hello" button (answers "verified" without the OS)
cargo run --release -p kasboek -- --service core     # kb-core on a real encrypted temporary database (see "Stubbed")
```

Options: `--theme light|dark|system`, `--lang en|nl|fr|de|es|es-419|pt-PT|pt-BR`, `--scale N`, `--today YYYY-MM-DD`,
`--slow-steps MS` (pause between the simulated loading steps, to see the loading view), `--data-dir DIR` (prefs.json; default
`<config>/kasboek-native-dev`, never the Electron app's folder), `--log FILE`, `--exit-after-ms N`, `--exit-after-first-frame`,
`--inset PX` (room for window controls drawn into the top bar; 12 by default, Electron uses 148).
`startup.log` is written next to the binary (previous run: `startup.prev.log`) with the milestones of plan section 5.

## Screenshots and checks

```sh
kasboek shot overview light out.png --today 2026-11-15          # 1440x900 at scale 2, like the Electron stills
kasboek shot lock-password|lock-device|lock-error|lock-busy|setup|setup-password|setup-recovery|loading|overview light|dark out.png
python tools/parity.py <shots> <electron-stills>   # pixel diff and landmark offsets against docs/screenshots of the release branch
tools/a11y-dump.sh target/release/kasboek [--state unlocked]    # AT-SPI tree (PYATSPI_PYTHON=/usr/bin/python3.12 where gi is for 3.12)
tools/startup-test.sh target/release/kasboek                     # CI: window opens, milestones logged, clean exit
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
| `src/log.rs`, `src/device.rs` | startup.log and the Hello / Touch ID prompt, moved here from the UI spike |
| `src/titlebar.rs` | Windows 11 title bar colour (DWM), system theme detection |
| `fixtures/household.json` | the invented household of the release screenshots (accounts, month summaries, budgets, tips) |

## Not ported yet / stubbed

- Pages other than the Overview are placeholder cards ("Not available in this version yet"); the assistant panel is a note.
  Buttons whose operations do not exist (Review, Get tips, Not useful / Hide) show a toast naming the operation.
- Login is simulated: `FixtureService` and `CoreService` accept the demo password; `kb-session` is not wired in yet.
  `CoreService` runs the ported ops (`accounts.*`, `categories.*`, `prefs.*`, `settings.*`, ...) on a real database; every
  Overview section whose op is not ported (or fails) shows its own "not available yet" text instead of crashing.
- Setup: choose, password (live strength meter with the shared rules), recovery key. No import, no 2FA step, no clipboard copy.
- The window is shown with `show()`: Slint 1.19's software renderer has no first-paint hook, so "first frame" is the first
  timer tick after `show()` (an upper bound), as in the spike. The window is not created hidden.
- Month names are English in all languages. The assistant panel, the Tour and Welcome are not built.
- macOS keeps the standard title bar (a transparent one needs winit window attributes behind an unstable Slint feature).
- Account numbers show only while the eye in the Accounts header is held (and are masked in the accessibility tree); the
  renderer shows none there.

## Needs Windows or macOS to confirm

Windows Hello and Touch ID prompts, the DWM title bar colours, Narrator / VoiceOver, IME and dead keys in the fields, fonts under
DirectWrite / CoreText, the system theme detection, and the build of `titlebar.rs` and `device.rs` themselves (written without a
compiler for those targets; `.github/workflows/rust-app.yml` is their first build).
