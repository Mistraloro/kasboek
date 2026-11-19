# Spike B: Slint UI (Lock screen + Overview)

Standalone cargo project (no workspace). Slint 1.19 (latest on crates.io when this was written; the plan said 1.17), GPL-3.0 option,
software renderer by default. Goal: gates G1 (geometry +-2 px, pixel diff <= 3%), G2 (fonts, accessibility) and G5 (start-up).

## Layout

| Path | What |
|---|---|
| `ui/*.slint` | `theme` (tokens of `styles.css`, light and dark), `widgets` (Button, Card, Field, PasswordInput), `lock` (Lock screen), `overview` (shell, sidebar, assistant panel, Overview, charts), `strings`, `app` |
| `src/strings.rs` | reads the Electron app's `en.json` (embedded with `include_str!`), fills the `Strings` global |
| `src/fixtures.rs` | the invented data; must match `tools/fixtures.json` |
| `src/shot.rs` | offscreen render to PNG with the software renderer (no display needed) |
| `src/startup.rs` | real window, startup.log-style milestones, `--renderer software|femtovg|skia` |
| `assets/fonts` | static Inter 400/500/600, "Inter Num" (tnum frozen) 400/500/600, Source Serif 4 500/600: 8 TTF, 474 KB, OFL-1.1 (from `@fontsource-variable`; licence texts next to them) |
| `assets/icons` | 17 lucide SVGs (ISC) and the Kasboek mark |
| `tools/` | `make-fonts.py`, `make-icons.mjs`, `reference.mjs`, `shots.sh`, `compare.py`, `startup-bench.sh`, `a11y-dump.sh` |

## Rerun

All outputs go to a scratch directory, e.g. `OUT=/tmp/kb-shots`. Run from `rust/spike/ui`.

```sh
# 0. one-time: fonts and icons (the generated files are committed, this is only needed to change them)
python3 -m venv /tmp/kb-venv && /tmp/kb-venv/bin/pip install fonttools brotli opentype-feature-freezer pillow numpy scipy
PATH=/tmp/kb-venv/bin:$PATH python tools/make-fonts.py
node tools/make-icons.mjs

# 1. Electron reference (needs `npm run build` at the repo root first, and `playwright` resolvable by node)
node tools/reference.mjs $OUT                    # ref-<screen>-<theme>.png + .json with DOM boxes

# 2. Slint renders and comparison
cargo build --release
tools/shots.sh $OUT                              # slint-<screen>-<theme>.png
/tmp/kb-venv/bin/python tools/compare.py $OUT    # prints diff % and landmark boxes, writes side-<name>.png (ref | slint | diff)

# 3. Start-up (Linux, needs Xvfb and libxkbcommon-x11)
tools/startup-bench.sh target/release/kasboek-ui-spike 10 lock-hello
cargo build --release --features femtovg --target-dir target-femtovg
target-femtovg/release/kasboek-ui-spike --renderer femtovg --screen lock-hello --exit-after-first-frame
cargo build --release --features skia --target-dir target-skia    # see "Renderers" in the report

# 4. Accessibility tree as a Linux screen reader sees it (apt: at-spi2-core python3-pyatspi dbus xvfb)
tools/a11y-dump.sh overview
# Focus ring and Tab order without a window manager: shot renders after N presses of Tab (the ring shows where the focus is)
target/release/kasboek-ui-spike shot overview light /tmp/tab3.png --tab 3
```

Window: `target/release/kasboek-ui-spike --screen lock-password|lock-hello|overview [--theme light|dark] [--scale 1|2]
[--lang en|de|fr] [--typing] [--renderer R] [--exit-after-first-frame] [--exit-after-ms N] [--log FILE]`. The last occurrence of an option wins.

- `startup.log` is written next to the binary (the previous run becomes `startup.prev.log`; `--log FILE` writes just that file;
  `KASBOEK_STARTUP_TRACE=1` also prints to stderr). Times count from the OS creation time of the process on Windows, Linux and macOS.
  Milestones: `process start`, `main entered`, `first frame painted`, `time-to-first-frame`, and on the lock-hello screen
  `device prompt requested` (button press), `device prompt shown`, `time-to-prompt`, `device answered (...)`.
- The button of `lock-hello` asks the OS (`src/device.rs`): Windows Hello through `IUserConsentVerifierInterop` (falls back to
  `UserConsentVerifier::RequestVerificationAsync`), Touch ID through `LAContext`. It only shows the answer; nothing is unlocked.
  Linux answers "unavailable".
- `--typing` adds a plain text field with an echo line, for accents, dead keys and IME. `shot` accepts `--lang` and `--typing` too.
- Accessibility: every control is a `FocusScope` (Tab, Space/Enter, screen reader Invoke) with role, label and a 2 px accent focus
  ring; decorative icons and the texts inside controls have `accessible-role: none`. `../ci/uia-dump.ps1` reads the window with
  Windows UI Automation in CI (`--exit-after-ms N` keeps the window open for it). Forgot password, Erase data, the eye, the
  assistant toggle, month buttons and the alert row can be invoked but do nothing (Forgot and Erase print a note under the card).
- The tools for owner testing on real machines are in `../ci/` and `../TESTING.md`; `.github/workflows/rust-spike.yml` builds them.

## Fonts

`@fontsource-variable` ships woff2 variable fonts (latin and latin-ext subsets, wght axis only, no opsz). Slint cannot use
variable fonts, so `tools/make-fonts.py` converts the latin subset to TTF, makes static instances with fonttools `instancer`
(wght 400/500/600 for Inter, 500/600 for Source Serif 4), renames the families and freezes `tnum` into a second family
("Inter Num") for the renderer's `.num` class. `font-feature-settings: 'cv11','ss01'` in `styles.css` is a no-op today: the
shipped latin subset has no `cv11` or `ss01` (its GSUB has only calt, ccmp, dnom, frac, locl, numr, pnum, tnum), so nothing needs
freezing. Latin only: add `latin-ext` (and merge) if a language needs it.

## Known limits of this spike

- Hover, focus rings (except the password field), pressed states, tooltips, the real hold-to-show password, wheel scrolling
  polish and the other 9 pages are not ported. Heights of wrapped texts and step rows are fixed for this fixture.
- The pixel comparison (G1) was done for English only. `--lang de|fr` renders the two screens with those locale files; the body text
  of the Lock card is measured, the wrapped texts of the Overview still have fixed heights, so long languages can overflow there.
- The reference has the 10 px styled scrollbar of the Electron window, drawn by hand in Slint (thumb only).
