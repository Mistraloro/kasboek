# kb-ui: the Kasboek design system (Slint)

Reusable Slint components, tokens, fonts, icons and charts, ported from the React renderer (`src/renderer/src/components/ui.tsx`,
`charts.tsx`, `Toast.tsx`, `DateInput.tsx`, `styles.css`), a component gallery, and the tools that check it against the
real renderer. Slint 1.19, software renderer. Plan: `docs/rust-port-plan.md` sections 2, 5, 10 (M3).

## Layout

| Path | What |
|---|---|
| `ui/theme.slint` | `Theme` (light/dark tokens, radii, type sizes, shadows, `dark` and `reduced-motion` switches), `Elevated` |
| `ui/fonts.slint`, `ui/icons.slint` | **generated** (see below): `Fonts` family names, `Icons` (74 lucide SVGs + mark, also under the React names) |
| `ui/base.slint` | `FocusRing`, `Pressable` and its roles (`PressTarget`, `SwitchTarget`, `CheckboxTarget`, `RadioTarget`, `TabTarget`), `Icon`, `Label`, `Session` |
| `ui/button.slint` | `Button` (primary/secondary/ghost/danger, icon, busy, small), `IconButton` |
| `ui/surface.slint` | `Card`, `CardHeader`, `PageHeader`, `Badge`, `EmptyState` |
| `ui/form.slint` | `Field`, `Input`, `PasswordInput` (hold to show), `CodeInput`, `Switch`, `Checkbox`, `RadioGroup`, `Segmented` |
| `ui/overlay.slint` | `Select` (popup list, keyboard, type-ahead), `Popover`, `Tip`, `HoverTip` |
| `ui/month.slint` | `MonthNav` (+ picker), `DateInput` (follows the date format) |
| `ui/dialog.slint` | `Modal`, `ConfirmDialog`, `ToastHost` |
| `ui/data.slint` | `ListView` (virtualised), `Scrollbar`, `Tabs`, `TableRow`, `TableCell` |
| `ui/progress.slint` | `Meter`, `ProgressBar`, `Spinner` |
| `ui/charts.slint` | `CategoryBars`, `MonthBars`, `TrendLine` |
| `ui/rules.slint`, `src/rules.rs` | what Slint cannot do (date parse/format, type-ahead search): callbacks implemented in Rust |
| `ui/texts.slint` | `UiText`: the few words the components speak themselves (English defaults, the app sets them) |
| `ui/cases.slint`, `ui/gallery.slint`, `src/bin/gallery.rs` | the gallery and its cases |
| `src/charts.rs` | scale numbers for the charts (`month_top`, `TrendAxis`, `category_rows`) and their text alternatives |
| `src/shot.rs` | offscreen rendering and synthetic keyboard/mouse input (used by `--shot` and the tests) |
| `tools/` | `make-fonts.py` + `fonts.json`, `make-icons.mjs`, `cases.json`, `parity.sh` + `parity.py` + `reference/`, `a11y-dump.sh` + `.py`, `uia-dump.ps1` |

## Using it from another crate

`build.rs` of kb-ui publishes the folder of the `.slint` files as `DEP_KB_UI_DIR` to crates that depend on it. In the app's
`build.rs`: `CompilerConfiguration::new().with_library_paths(HashMap::from([("kb-ui".into(), dir.join("lib.slint").into())]))`
(add a `ui/lib.slint` that re-exports what the app needs when that crate exists), or simply import `<DEP_KB_UI_DIR>/button.slint`
by path. Rust side: `kb_ui::wire_rules!(&window)` once per window (needs `Rules` and `DateCheck` in scope from
`slint::include_modules!()`), `kb_ui::charts::*` for chart scales and summaries, `kb_ui::shot` for tests.

## Gallery

```sh
cargo run --release -p kb-ui --bin kb-ui-gallery                      # all cases in one window; --theme dark, --case NAME
kb-ui-gallery --shot button dark out.png [--scale 2] [--tab 3] [--keys "Tab,Down"] [--hover X,Y] [--hold X,Y]
kb-ui-gallery --list-cases
```

Real windows take the OS scale factor (`SLINT_SCALE_FACTOR=1.5` overrides); `--shot --scale N` renders at N. The theme is
`Theme.dark`, set at any time; `Theme.reduced-motion` stops the spinner and indeterminate bar.

## Rules

**Tokens.** Colours, radii, type sizes and shadows come from `Theme`; font family names from `Fonts` (through `Theme.sans/num/serif`).
No hex colour, font name or radius literal in a component, except sizes that are Tailwind arbitrary values of the renderer (then
copy the value and say which class it is). Numbers use `Theme.num` (Inter with `tnum` frozen), data and running text `Theme.sans` (Inter); titles, headings, card titles, dialog titles, the logo and button labels use `Theme.serif` (Playfair Display, shipped as "Kasboek Display" because the OFL reserves its name for modified versions; see `tools/make-fonts.py`). The font has no `ij` ligature glyph (Dutch "ij" is two letters).
Text height: set a CSS line box with `Label { lh: ... }`; Slint's own line height differs.

**Fonts.** One place names them: `tools/fonts.json` (family, @fontsource-variable package, weights, frozen features). Edit it and run
`python tools/make-fonts.py` (needs `pip install fonttools brotli opentype-feature-freezer`, `npm ci` at the repo root for the
packages). It rewrites `assets/fonts/*.ttf`, the OFL licence texts and `ui/fonts.slint`. Slint cannot use variable fonts, hence static instances.

**Icons.** `node tools/make-icons.mjs` scans `src/renderer/src` for `lucide-react` imports and rewrites `assets/icons/*.svg` and `ui/icons.slint`.
Use `Icon { source: Icons.eye; size: 16px; tint: Theme.muted; }`. An icon is decorative: it is not in the accessibility tree.

## Adding a component

1. Put it in the file of its family in `ui/` (or a new file imported by `gallery.slint`). Colours only from `Theme`.
2. A control is a `Pressable` flavour (`PressTarget`, `SwitchTarget`, ...) laid over its visuals: Tab focus, focus ring, Space/Enter,
   screen reader action, hover/pressed come with it. Anything else with a role is a `FocusScope` with the same pieces.
3. Add a case to `ui/cases.slint` showing every state (`simulate: "hover" | "focus" | "pressed"` forces one), list it in `gallery.slint`
   (section and `if root.case == ...`) and in `tools/cases.json` (size).
4. If the renderer has the component, add its twin to `tools/reference/harness.tsx` at the same absolute positions and run `tools/parity.sh`.
5. Run `cargo fmt`, `cargo clippy -p kb-ui --all-targets -- -D warnings`, `cargo test -p kb-ui`, and the accessibility dump.

## Accessibility checklist

- Every control: `accessible-role`, `accessible-label` (a name), `accessible-description` for hints, `accessible-enabled`, and
  `accessible-action-default` (Invoke). Checkable things: `accessible-checkable` + `accessible-checked`.
- A control is a focusable `FocusScope`; a `TouchArea` alone is invisible to keyboards and screen readers.
- Texts and icons inside a control: `Label` has role `none` by default (the control names itself); set `accessible-role: text` only for
  text to be read on its own (titles, hints, errors). Icons are `none`. An `accessible-role: none` set on a *component instance* whose
  root is an Image does not work: use the plain element (Icon has a Rectangle root for this reason).
- `accessible-role` must be a constant: a role that depends on state needs two elements.
- Keyboard: Tab order = tree order; Space/Enter activate; arrows in groups (Segmented, Tabs, Radio, month grid, lists); Escape closes
  popups/dialogs; the ring shows only for keyboard focus (mouse clicks do not focus buttons).
- A hidden thing stays in the accessibility tree: instantiate dialogs under `if` instead of hiding them.
- Check on Linux: `tools/a11y-dump.sh CASE` (AT-SPI: roles, names, states) and `--shot CASE light out.png --tab N`. On Windows:
  `tools/uia-dump.ps1 -Exe kb-ui-gallery.exe -Case CASE` (the workflow `rust-ui.yml` runs it, informational).

## Parity with the renderer

```sh
python3 -m venv /tmp/kb-venv && /tmp/kb-venv/bin/pip install numpy pillow scipy
PY=/tmp/kb-venv/bin/python tools/parity.sh /tmp/kb-parity [case ...]
```

It bundles `tools/reference/harness.tsx` (the real `ui.tsx`, `charts.tsx`, `Toast.tsx`, `DateInput.tsx`) with the renderer's Vite
plugins, screenshots every case in Chromium (hover/focus forced through the DevTools protocol), renders the same cases with the
gallery, and prints per case and theme the differing pixels (gate 3 %) and the landmark boxes (gate 2 px). `side-*.png` shows
reference, Slint and the diff. Cases without a React component (`choice`, `progress`, `select-open`) are gallery-only.

## Known gaps (Slint limits)

- No text decoration, no dash arrays (dashed gridlines are drawn as segments), no rotation of rectangles (the spinner moves arc end
  points), no `substring`/search on strings or reduce over models (hence `Rules` and `charts.rs`), no height-for-width guarantee for
  wrapped text in every layout (check wrapped texts per language), no shadow spread (shadows are approximated), no dialog role,
  password mask is Slint's fixed `●` (larger than Chromium's bullet), `CodeInput` refuses an over-long paste instead of cutting it.
- Window blur does not hide a revealed password by itself: the app bumps `Session.hide-secrets` (winit event hook in the app crate).
- Month names of `DateInput` are English until the i18n crate exists.
