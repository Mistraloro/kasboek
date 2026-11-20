# Kasboek: port to a fully native Rust app (plan)

Branch: `rust-native`. The Electron app keeps shipping from `main` until cut-over. Status: plan. The M0 spike ran on Linux x64 (results in section 10). M1 has started: the workspace, `kb-sqlite3mc-sys`, `kb-crypto`, `kb-db` and `kb-cli` exist in `rust/` (progress in section 10).
Goal: the same app, behaving the same (with exceptions listed in section 5), looking like a copy of the current UI
(fonts swappable), starting fast and installing small, on Windows x64/ARM64, macOS arm64/x64, Linux x64/arm64.
Non-goals: new features, a mobile app, changing any file format, changing the MCP helper's protocol.

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| UI toolkit | **Slint 1.x** (the spike used 1.19.0). The software renderer is the test renderer and the fallback; it matched the Electron reference within 2.0% of pixels in the spike. FemtoVG builds and renders. Skia did not run in the spike container (unverified). |
| Layout | A Rust workspace in `rust/` next to the TS sources. TS stays runnable as the reference for differential tests until cut-over. |
| Operation list | `kb-core::dispatch(op, json)` over the same 154 op names, inputs, outputs and error codes as `src/shared/contract.ts`. |
| Database | sqlite3mc **2.4.0** (SQLite 3.53.4), built from the amalgamation with the same defines, `cipher='chacha20'` + `hexkey`. Spike A: Rust and Electron read each other's files on Linux x64. Other targets not yet built. |
| Storage engine | sqlite3mc now, kept for compatibility with existing encrypted databases, backups, exports and sync files. Behind a swappable `Store` trait in `kb-db` (section 3). |
| PDF | **Pure-Rust reader: `hayro-interpret` / `hayro-syntax` 0.9 plus our own glyph-merging layer (spike C). pdfium is dropped.** Runs in a child process with a 60 s kill and a 1 GiB memory cap. Open: fonts without ToUnicode give no text. pdf.js (JavaScript) would need a helper to serve as fallback, so that choice is pending (section 10). Line and statement logic ported 1:1. |
| MCP helper | `tools/kasboek-mcp` (Go) unchanged. The Rust app implements the bridge server side of the same protocol. |
| Start-up | No splash window. The first frame is the real Setup/Lock screen. The Hello/Touch ID button is part of the first frame; the OS prompt opens only when the person presses it (section 5). |
| Parity | Differential TS-vs-Rust runs on invented data, cross-opened files, and fixture-driven screenshot and geometry diffs. |
| First step | A 2–3 week spike with go/no-go gates (section 7, M0). |
| Exact-copy scope (owner decision) | The "exact copy" requirement is relaxed for small native details: password mask glyph, native dropdown arrow or chevron, anti-aliasing, and 1–3 px spacing differences are acceptable and can be adjusted later, as long as the result fits the design. The pixel gate (3%) and landmark gate (2 px) become guidelines for layout, colours, typography and component proportions, not blockers for these details. See section 10 (polish list). |

## 1. Inventory of the current app

Size (lines, excluding node_modules). Tests: **863 passing in 70 files** (`npm test`, about 21 s here).

| Area | Files | Lines | Notes |
|---|---|---|---|
| `src/core` | 50 | 8,709 | Pure logic: finance, import, sync, crypto, formats. Electron-free and portable. |
| `src/main` | 49 | 7,318 | Electron main: IPC dispatch (`ipc.ts` 672), session, sync service, updater, assistant, MCP, PDF process, tray |
| `src/shared` | 26 | 3,140 | contract (755), types (902), format (330), password, iban, permissions |
| `src/renderer/src` pages + components + lib | 57 | 7,934 | React + Tailwind 4, lucide icons (74 distinct), custom SVG charts |
| i18n locales | 8 | 9,854 | 1,329 keys (en/nl/fr/de/es/pt-PT full, es-419 141, pt-BR 328 overrides), i18next plurals and `{{var}}` |
| `tests` | 72 | 9,971 | About 52 files test core/shared only (directly portable), about 14 touch main, 1 renderer |
| `tools/kasboek-mcp` (Go) | 24 | 3,721 | MCP stdio server, Windows MSI update applier with a GDI progress window, launcher |

**Operations** (`src/shared/contract.ts:74-703`, 154 ops; `PUBLIC_OPS` at `:713` work while locked):
app 4, prefs 2, update 5, auth 14, transfer 3, backup 7, assistant 12, import 21, export 2, mcp 8, settings 2,
networth/valuations/balances/summary.year 8, sync 7, fx 5, accounts 3, categories 3, transactions 11 (incl.
splits/rename/categorize/delete), searches 2, goals 4, memory 7, alerts 1, summary.review/month 2, insights 7,
recurring 2, transfers 5, rules 6, budgets 3. There are 17 event types (`AppEvent`, `contract.ts:739`).
53 ops carry a `description:`, and those with `coreOps[op].assistant` become assistant/MCP tools whose JSON
Schemas are generated from zod (`src/main/assistant/tools.ts:27`).

**Screens** (renderer lines):

| Screen | Files (lines) | Main features |
|---|---|---|
| Shell | `App.tsx` 203 | Sidebar nav (8 pages + Settings, Lock, version), custom title bar (mac traffic lights at 16,15; Windows caption overlay with `pr-[148px]`), assistant toggle, update button, MCP requests, Tour |
| Auth | `auth/*` 787 | Setup (password rules, passwordless), Lock (password / Hello / Touch ID, 2FA code, remember 30 days, recovery key, throttle, erase/restore), ImportFlow (.kasboek), RecoveredModal |
| Welcome + Tour | 327 + 128 | First-run window, 11-step spotlight tour |
| Overview | 192 + Suggestions 331 + BankBalance 169 | Month summary, charts, alerts, insights tips (local + AI), month review |
| Transactions | 582 | Filters, saved searches, paging, edit, split, rename, bulk categorise/delete, transfers pairing, CSV export |
| Budgets | 280 | Per-category budgets, copy previous month, meters |
| Recurring | 268 | Detected fixed costs/income, hide, due/late status |
| Goals | 129 | Goals with account or manual savings |
| Year | 155 | Year summary, PDF report (`export.pdf` via `printToPDF`, `src/main/export.ts:27`) |
| Net worth | 202 | Net worth trend, valuations, bank balances |
| Import | 234 + import-parts 641 | CSV/PDF/XML (CAMT) analyse, mapping modal, preview grid, AI check/PDF assist with consent, undo batches |
| Settings | 72 + 11 sections 835 + Claude 459 + Memory 126 + ModelPicker 206 + ClaudeApps 93 + WebDav 55 | Accounts, appearance, formats, currencies/FX, backups, transfer, security (password, Hello, 2FA QR, recovery), sync, insights, AI providers/models/permissions, MCP setup, about |
| Assistant panel | 343 + McpRequests 58 + PromptModal 84 | Streaming chat, minimal markdown (`AssistantPanel.tsx:33`), tool confirmations, stop/reset, page context |
| Primitives | `ui.tsx` 409, `charts.tsx` 186, Toast 39, DateInput 50, Update 108 | Button, Card, PageHeader, Field, Input, PasswordInput, native `<select>`, Segmented, Switch, Badge, EmptyState, Modal, MonthNav; CategoryBars, MonthBars, Meter, TrendLine with hover tips |

**Design tokens**: `src/renderer/src/styles.css:6-73`: light/dark colour sets, Inter Variable + Source Serif 4
Variable (the native app uses Kasboek Sans = Lato and Kasboek Display = Playfair Display instead, see
`rust/crates/kb-ui/tools/fonts.json`), 14 px/1.5 base, `font-feature-settings: 'cv11','ss01'`, `.num` = tabular-nums, focus ring 2 px, custom
scrollbars, reduced-motion.

**Main-process / platform features**: single instance + `--background` (MCP launch, tray only)
(`src/main/index.ts:28`); splash window (`splash.ts`, to be removed, section 5); graphics fallback and `startup.log`
(`graphics.ts`); prefs.json; account.json sealed with safeStorage (`security/account-store.ts`); Windows Hello via
PowerShell/WinRT, Touch ID (`security/device-auth.ts`); auto-lock on idle/lock-screen/suspend (`session.ts`);
quarantine "erase" (`quarantine.ts`); backups scheduler and export/import (`transfer/*`); sync service with
folder and WebDAV (`sync/service.ts` 638); ECB FX download; notifications (`notify.ts`); tray (`tray.ts`); MCP
bridge over a named pipe or Unix socket with a discovery file and token (`mcp/*`); Claude Desktop/Code config
editing (`mcp/setup.ts`, `core/mcp-config.ts`); updater from GitHub releases with SHA256SUMS, an MSI via the Go
helper, AppImage self-replace, dmg/deb opened (`update.ts`, `core/update.ts`); file dialogs, openExternal, clipboard.

**Packaging** (`electron-builder.yml`): MSI per-user x64+arm64 (UpgradeCode `7f3c2a1e-4b5d-4c8e-9a6f-2d1b0e9c8a74`,
art from `build/msi-project.cjs`), dmg arm64+x64 (ad-hoc signed unless CSC_* set), AppImage + deb x64+arm64,
`kasboek-mcp` in resources. Asset names are matched by `pickAsset` (`src/core/update.ts:25`). Electron's
`dist` alone is 274 MB unpacked.

## 2. Rust UI toolkit decision

Scores: 3 = strong, 2 = workable with effort, 1 = weak, 0 = missing. "(u)" = could not verify offline or in the
docs, so it is a spike task.

| Criterion | Slint 1.17 (spike: 1.19) | GPUI (+gpui-component) | iced 0.14 | egui | Dioxus Native (Blitz) |
|---|---|---|---|---|---|
| Tailwind look: radius, borders, shadows, clip, gradients | 2: all present; spread/inner shadow Skia-only; every utility hand-translated | 3: API modelled on Tailwind (`rounded_lg`, `shadow_md`) | 2 | 1 | 3 (real CSS) but buggy |
| Layout model (flex, tables) | 2: H/V/Grid layouts, no CSS auto table widths | 3: Taffy flex/grid | 2 | 1 | 3: Taffy + block/inline |
| Text shaping, accents, 8 languages | 3 | 3: DirectWrite/CoreText/cosmic-text | 2: cosmic-text | 1: no complex shaping | 3: Parley |
| OpenType features (cv11, ss01, tnum), variable axes | Spike B: tnum via static instance; variable fonts unusable | 3 | (u) | 0 | 3 |
| IME | 2 | 3 | 2 (new in 0.14, partial) | 2 | 1 (u) |
| Screen readers (UIA / NSAccessibility / AT-SPI) | **2: AccessKit shipped; we must label custom components** | **0–1: not shipped (branch only)** | **0–1: fork only** | 2: AccessKit | 1: partial |
| Dialogs, popovers, tooltips, menus | 2: PopupWindow, Dialog, ContextMenu; tooltip custom | 3 | 2: tooltip, overlay | 2 | 1: form controls incomplete |
| CPU fallback (Windows on ARM GPU trouble, `src/shared/graphics.ts`) | **3: software renderer** | 1: needs Metal/DX11/Vulkan | 3: tiny-skia | 2 | 1 (u) |
| 6 targets incl. aarch64-pc-windows-msvc | 3 (Skia prebuilt for win-arm64: u) | 2 (u) | 3 | 3 | 2 (u) |
| Binary size (app) | 3: 12.57 MB measured for the two spike screens with the software renderer (estimate was 6–12 MB); femtovg 13.17 MB, skia 19.56 MB | 2: 15–30 MB | 2: 8–15 MB | 3: 4–8 MB | 1: 15–25 MB (Stylo) |
| Cold start | 3: UI compiled to Rust, no parsing | 3 | 2: wgpu init | 3 | 2 |
| Maturity / API stability | 3: semver 1.x since 2023, company-backed | 1: no official stable crate, community repackages | 2: 0.x, breaking releases | 2 | 0–1: pre-alpha (0.3.0-alpha.4) |
| Licence vs GPL-3.0-only | 3: GPL-3.0 option (or royalty-free) | 3: Apache-2.0 | 3: MIT | 3 | 3: MIT/Apache, Stylo MPL-2.0 |
| Ease of a first-screen prototype | 2: DSL + live preview | 2 | 3 | 3 | 3: could reuse Tailwind CSS |

**Recommendation: Slint.** It is the only candidate that has all of the following today: shipped accessibility on
all three desktops, IME, a CPU renderer for the Windows-on-ARM graphics history, a stable API with a funded
maintainer, a GPL-3.0-compatible licence, and small, fast-starting binaries. Skia is closer to Chromium's rasteriser, but it did not run
in the spike container, so that is unverified (section 10).

Honest weaknesses of Slint:
- Every Tailwind class becomes a hand-written property on ~20 components.
- Tables need computed column widths.
- Tooltips and the spotlight tour are custom code.
- The custom title bar (Windows caption buttons with Snap Layouts, macOS traffic-light inset) needs winit-level work.
- Slint cannot use variable fonts. Mitigation that keeps fonts swappable: ship **static instances** (fonttools
  `instancer`, with `tnum` frozen into an "Inter Num" family for `.num`), produced by a script from any OFL font.
  Swapping fonts means re-running the script. Spike B: the shipped latin subset has no `cv11` or `ss01`, so there is
  nothing to freeze for them (the CSS line is a no-op today).

**Alternatives:**
- **GPUI** wins on styling and text, but has no screen-reader support today and no stable crate. Use it only if
  the spike fails gates G1–G2 and the owner accepts losing screen-reader support. I would rather stop the port.
- **Blitz** would render the existing Tailwind CSS almost for free, but it is pre-alpha with incomplete form
  controls and accessibility. Re-check at M3; do not depend on it.
- Rejected: Xilem/Masonry (right stack of Vello + Parley + AccessKit, but alpha, few widgets, GPU compute on Adreno
  is a risk); Floem (no accessibility); Makepad (no accessibility, own shader DSL); Freya (small team, Skia size,
  partial accessibility); Qt via cxx-qt and GTK4 (UI not in Rust, larger installs, or not an exact copy).
  Qt is the emergency fallback only if the owner drops the all-Rust rule.

## 3. Workspace layout (`rust/` on `rust-native`)

```
rust/Cargo.toml                 workspace; one version, mirrored from package.json at release time
crates/kb-sqlite3mc-sys         cc-builds sqlite3mc 2.4.0 amalgamation with the defines of
                                node_modules/better-sqlite3-multiple-ciphers/deps/defines.gypi (SQLITE_DQS=0,
                                DEFAULT_FOREIGN_KEYS=1, LIKE_DOESNT_MATCH_BLOBS, MATH_FUNCTIONS, FTS5, THREADSAFE=2, ...);
                                rusqlite links it (libsqlite3-sys with SQLITE3_LIB_DIR/STATIC, or [patch])
crates/kb-crypto                seal/unseal (AES-256-GCM + label AAD), slots + KDFs, HKDF, TOTP, base32, recovery key,
                                .kasboek (KASBOEK2) and .kbsync (KBSYNC1) codecs; zeroize all keys
crates/kb-db                    open/unlock pragmas, the 15 migrations, `fx()` SQL function, sync triggers, VACUUM INTO
crates/kb-core                  contract (typed op inputs/outputs, validation, error codes), account logic, finance,
                                rules, budgets, recurring, insights, review, alerts, goals, wealth, balance, transfers,
                                fx, memory, settings, sync engine (HLC merge), backup tiers, quarantine, update helpers,
                                `dispatch()`; Clock + Rng injected
crates/kb-import                csv (decode, mapping, normalize), camt (own XML reader), pdf lines/statement, fingerprint
crates/kb-pdf                   hayro-based PDF text reader producing the same PdfText items as src/core/pdf/extract.ts (spike C)
crates/kb-assistant             Anthropic + OpenAI-compatible streaming clients (reqwest + SSE), tool loop, csv/pdf
                                assist plans, insight plan, page context, permissions, masking
crates/kb-sync                  folder + WebDAV stores, sync service orchestration
crates/kb-i18n                  the 8 existing locale JSON files (include_str!, read as-is), i18next-compatible
                                lookup/fallback/plurals/interpolation; static CLDR tables dumped from Node's ICU
crates/kb-platform              paths, prefs, startup.log, OS seal (+ legacy Electron reader), Hello/Touch ID,
                                idle/lock/suspend, single instance, dialogs (rfd, portal), notifications, tray
                                (tray-icon on Win/mac, ksni on Linux), theme detection, MCP bridge server, updater
crates/kb-ui                    Slint: theme global (tokens), fonts, icons (lucide SVGs), primitives, charts, screens
apps/kasboek                    the app binary (`--background`, `--pdf-reader` child mode)
apps/kb-cli                     dev only: run ops/scenarios from JSON for the parity harness (never shipped)
parity/                         harness: TS runner, scenarios, fixtures, UI screenshot/geometry diff scripts
```

**Storage boundary (`kb-db`).** Only `kb-db` talks to the engine. It exposes a `Store` trait with: open/unlock with
key; transactions; migrations keyed by schema version; prepared query helpers; user-defined function registration
(`fx`); change hooks used by the sync triggers; backup (VACUUM INTO equivalent); integrity check. All SQL lives in
`kb-db` (or a `queries` module behind the trait), never in `kb-core`, which depends on the trait only. Migrations are
written engine-neutrally, with a note on every SQL dialect difference (sqlite3mc today).

A `store-conformance` suite must pass for any engine: the same invented datasets, cross-open, migration paths 1 to 15,
sync trigger behaviour, and the performance benchmark (`kb-bench`).

Future engine (e.g. Turso/limbo, only if mature, with encryption at rest and import of existing data): a one-time
export/import with verification, and the old file kept as a backup. Screens and business logic do not change.

Caveats: the abstraction adds code and some cost; SQL dialect will leak through; no pure-Rust engine is known to be
mature enough today (unverified).

**Interfaces** (new):

```rust
// kb-core
pub struct AppError { pub code: String, pub message: String, pub details: Option<ErrorDetails> } // same codes as TS AppError
pub enum Actor { User, Assistant, System }
pub trait Clock: Send + Sync { fn now_ms(&self) -> i64; }
pub fn dispatch(core: &Core, op: &str, input: serde_json::Value, actor: Actor) -> Result<serde_json::Value, AppError>;
// typed wrappers generated by one macro from the op table: ops!{ "transactions.list" => TxList(TxListIn) -> TransactionPage, ... }
// kb-ui talks to the core only through this (real service, or a fixture service for screenshots)
pub trait AppService: Send + Sync {
    fn invoke(&self, op: &'static str, input: serde_json::Value) -> BoxFuture<'static, Result<serde_json::Value, AppError>>;
    fn subscribe(&self) -> Receiver<AppEvent>;
}
// kb-platform
pub trait OsSeal { fn seal(&self, plain: &[u8]) -> Result<Vec<u8>>; fn open(&self, sealed: &[u8]) -> Result<Vec<u8>>; fn protection(&self) -> KeyProtection; }
pub fn open_electron_seal(data_dir: &Path, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, LegacySealError>; // read-only, migration only
```

Assistant tool schemas: a TS script on `rust-native` dumps `assistantTools()` (names, descriptions, JSON Schemas)
into `rust/crates/kb-assistant/tools.json`. Rust serves that file as-is, and a test checks that Rust validation
accepts and refuses the same sample inputs. This avoids re-deriving zod's JSON Schema output.

## 4. Compatibility plan

**Data folder**: Electron `userData` = `%APPDATA%\Kasboek`, `~/Library/Application Support/Kasboek`,
`$XDG_CONFIG_HOME/Kasboek`. Use the same paths (`dirs::config_dir()/Kasboek`) and the same file names
(`src/main/paths.ts`): `kasboek.db`, `account.json`, `keystore.json` (legacy), `prefs.json`, `sync.json`,
`safety-backups/`, `erased/<time>/`, `updates/`, `app.json`, `mcp-bridge.json`, `startup.log`,
`startup.prev.log`, `startup.version`.

| Item | Exact current behaviour (source) | Rust | Risk |
|---|---|---|---|
| DB | sqlite3mc 2.4.0, `PRAGMA cipher='chacha20'; PRAGMA hexkey='<64 hex>'` first, probe `SELECT count(*) FROM sqlite_master`, then `foreign_keys=ON`, `secure_delete=ON`, `journal_mode=DELETE`, migrate, `fx()` (`src/core/database.ts:11-39`). Schema version = `PRAGMA user_version` (15 migrations, `migrations.ts:12`) | Same library version and defines (kb-sqlite3mc-sys), same pragma order. The chacha20 KDF and salt are internal to sqlite3mc, so identical library defaults give identical files | **High** until cross-open passes on all 6 targets (Linux x64 only so far, section 10). Do not move to a newer sqlite3mc until both sides use it |
| `fx(cents, from, date, to)` | JS UDF, rates preloaded, non-deterministic flag (`src/core/fx.ts:81`) | rusqlite `create_scalar_function`, same lookup rule, same NULL semantics | Low |
| Slots | AES-256-GCM, 12-byte IV, base64 `{iv, ct+tag}`, AAD `kasboek:slot:password` / `kasboek:slot:recovery`; Argon2id m=131072 KiB, t=3, p=4, 32-byte output, password NFKC; caps m≤1 GiB, t≤10, p≤16, m≥8p; HKDF-SHA256 info `kasboek:slot` for the recovery key (normalised `XXXX-...`); scrypt N≤2^20, r≤16, p≤4 legacy, upgraded on unlock (`src/core/crypto.ts:35-98`) | RustCrypto `aes-gcm`, `argon2` (v0x13), `hkdf`+`sha2`, `scrypt`, `unicode-normalization`. Keep the caps | Low. Spike A: the password slot works in all four directions; Argon2id ~300 ms in Rust (lanes run serially) vs ~490 ms with hash-wasm (section 10) |
| Vault / account | Vault JSON `{dbKey, totp?}` sealed with label `kasboek:vault`; AccountData v2 `{mode, createdAt, twoFactor, slots{password?, recovery, device?}, vault, attempts, remember2fa?}`; remember MAC = HMAC-SHA256(master, `kasboek:remember2fa:<ISO until>`) (`src/core/account.ts`) | serde with `preserve_order`; ISO times formatted like JS `toISOString()` (ms + `Z`); throttle 5 free tries then 30·2^(n-5) s up to 15 min | Medium (time formats, JSON key order) |
| account.json file | `{format:'kasboek-account', version:2, seal:'os'|'none', data}`; `os` = Electron `safeStorage.encryptStringAsync` (`account-store.ts:66`) | Rust cannot call safeStorage. **(a)** A read-only decoder for Chromium OSCrypt: Windows uses the `Local State` `os_crypt.encrypted_key` (DPAPI) and AES-GCM `v10`; macOS uses the Keychain "Kasboek Safe Storage" and AES-128-CBC `v10`; Linux uses libsecret/kwallet `v11` or `v10` "peanuts". Then re-seal as `seal:'os-native'` (DPAPI user scope / Keychain item holding a wrap key / Secret Service), and keep the original as `account.electron.json`. **(b)** If decoding fails: "Open with your password or recovery key" from the newest `safety-backups/*.kasboek`, which recreates the account | **Highest.** The async OSCrypt format in Electron 45 is (u) on every OS. macOS will show a Keychain prompt once (new signature). Spike task G6 |
| Legacy keystore.json | `os:` / `plain:` prefixes (`account-store.ts:81`) | Same decoder as (a) | Low (rare) |
| .kasboek export/backup/snapshot | `KASBOEK2` + u32 BE header length + header JSON + AES-GCM(u32 vault length + vault JSON + encrypted DB) + tag; key = HKDF(master, salt, `kasboek:file:v2`); AAD = magic+length+header; header ≤ 64 KiB; `KASBOEK1` refused (`transfer-format.ts`) | Byte-compatible codec. Read side uses the header bytes as written | Low |
| .kbsync | `KBSYNC1\n` + u32 + header + IV(12) + tag(16) + AES-GCM(deflate-raw JSON); AAD = magic+header; key = `secrets.syncKey` hex; headers checked against the file's place; inflate cap 256 MiB (`sync-file.ts`) | `flate2` raw deflate; compare decoded JSON, not compressed bytes | Low |
| Sync engine | Per-field HLC, triggers to `sync_outbox`, `sync_rows`, conflicts, pending (`sync.ts`, `sync-schema.ts`) | Port 1:1. **Mixed fleets (one Electron and one Rust computer) must sync both ways** | Medium: number typing (JS numbers vs SQLite INTEGER/REAL), float JSON formatting |
| prefs.json | Plain JSON, defaults in `src/main/prefs.ts:8`, legacy `formatLocale` upgrade | Same file. New non-secret keys (section 5): `lastAuth`, `graphics` mapped to renderer choice | Low. Unknown keys must be kept on write |
| startup.log | `"%6d ms  text\n"` (`startup-plan.ts:107`), rotated to `.prev`, version marker | Same format, new milestone names (section 5) | Low |
| Formats/i18n | `Intl` for currency digits/symbols and month names, `localeCompare` (`shared/format.ts:159-211`, `core/insights.ts:111`) | Static tables dumped from Node's ICU for all `CURRENCIES` × 8 languages. Replace `localeCompare` with ICU4X root collation, or prove inputs are ASCII | Medium: sort order of tips |
| Install layout | `%LOCALAPPDATA%\Programs\Kasboek\Kasboek.exe`, `resources\kasboek-mcp.exe`; mac `Kasboek.app/Contents/Resources/`; deb `/opt/Kasboek` | Keep exe names and helper paths so Claude Desktop configs and `app.json` stay valid. MSI with the same UpgradeCode, per-user; bundle id `app.kasboek`; same deb package name; release assets named exactly as `pickAsset` expects | Medium |

**Crates:** rusqlite, aes-gcm, argon2, scrypt, hkdf, hmac, sha1, sha2, rand/getrandom, zeroize, subtle, base64,
serde/serde_json (`preserve_order`), flate2, encoding_rs (same WHATWG decoders as `TextDecoder`), regex or
fancy-regex (13 lookaround/backreference uses in core), reqwest + rustls with rustls-platform-verifier (OS trust
store), tokio, interprocess (named pipe / Unix socket), windows (DPAPI, UserConsentVerifier interop with our own
HWND, idle, session/power notifications, toasts), objc2 + objc2-local-authentication + security-framework (Touch
ID, Keychain), zbus/oo7 (Secret Service, logind, screensaver idle), rfd (xdg-portal on Linux), tray-icon/muda,
ksni, notify-rust, arboard, sys-locale, dark-light, qrcode, hayro-interpret and hayro-syntax 0.9 (pinned; pure Rust, no C) for PDF text. pdfium binaries are not bundled.

**Printing the year report to PDF** (`export.pdf` uses Chromium `printToPDF`): generate the PDF directly
(`krilla` or `printpdf` with the same embedded fonts), keeping the same content and A4 margins. This is a visible
difference: say so in the release notes. The op changes to take structured data instead of HTML.

**Schema lockstep:** a migration added on `main` during the port must be ported in the same week (parity test
`schema-dump` fails otherwise). Prefer a schema freeze from M2 to cut-over.

## 5. Start-up and unlock (owner requirements)

No separate launcher or splash window. The window is created **hidden**, with its background set to the theme
colour from prefs.json. It is shown only after its **first paint**: Slint rendering notifier `AfterRendering`,
then `show()`. The first frame is the real screen: Setup (no account), Lock, or the tray-only background start
(`--background`, no window, as today).

Before the first frame (on the critical path, kept minimal):
1. Single-instance check, then read prefs.json (theme, language, `lastAuth`).
2. Fonts are embedded in the binary. Only the faces the Lock/Setup screen uses are registered (Inter
   400/500/600, Serif 600).
3. Only the active locale and `en` are parsed.
4. Slint compiles the Lock and Setup components into the binary.

**Prefs cache `lastAuth`** (non-secret): `{ mode: 'password'|'device', device: 'windows-hello'|'touch-id'|null,
twoFactor: bool, rememberedUntil: string|null }`. It is written after every successful unlock and after
security changes. The first frame uses it, so the Lock screen is already in the right mode. If it is missing,
render password mode and correct it once account.json has been read.

**Device-auth path (top priority, because many users unlock with Hello or Touch ID):**
1. First frame painted. It shows the Lock screen in device mode, using the cached `lastAuth`, with the
   "Unlock with <device>" button already visible.
2. The OS prompt opens **only when the person presses the button**; there is no automatic prompt. Windows:
   `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with our own HWND (replaces the PowerShell
   child process, `device-auth.ts:189-296`). macOS: `LAContext evaluatePolicy`. The press must be answered at
   once: background preloading must never delay the button press response, so the prompt appears right when
   pressed.
3. Background preloading (other locales, remaining fonts, icons, other screens' state, the updater, sync
   modules) is held back until the prompt has been shown and answered or cancelled. It runs at lower thread
   priority so it never competes with the prompt.
4. On success: OS-unseal account.json, take the device slot (master key), open the vault, open the DB and check
   migrations. This shows as an in-place "Unlocking…" state on the Lock screen. Then the first unlocked frame
   (Overview).
5. If 2FA is on and this computer is not remembered, the code field is shown first; the button stays as it is
   today (`pages/auth/Lock.tsx:91`), and the person presses it to start the OS prompt.

Safety rules kept from today:
- Cancel or failure leaves the Lock screen with "Unlock with …" and the recovery-key link.
- Hello unavailable or changed: `auth.device_*` errors (`device-auth.ts:120`). The availability check runs in the
  background after the first frame, and its negative answers expire after 10 s.
- Failed attempts are recorded and throttled as today.
- The password stays the unlock path for password accounts.

**Password path:**
1. The first frame shows the field.
2. In the background, read account.json bytes and the slot KDF parameters. For password accounts, unsealing
   account.json exposes only the sealed slots and vault.
3. On submit, only Argon2id + unwrap + DB open remain, shown as in-place "Unlocking…". It must not be slower than
   today's ~0.5 s KDF; measure it.

**Nothing decrypted before authentication:**
- For **device-mode accounts, account.json is not OS-unsealed before the prompt succeeds**, because it contains
  the master key (`account.ts:33`).
- For password accounts, unseal it into memory without keeping `slots.device` (absent anyway) and zeroize after
  use.
- No vault, DB key or DB handle exists before unlock. Locking drops and zeroizes all of them (as `session.ts`
  does now).

**After the unlock: loading screen with real progress (owner requirement).**
- When the unlock succeeds (Hello success or password accepted), a timer of **180 ms** starts.
- If the first useful screen (the Overview with totals) is ready before the timer runs out, it is shown directly, with no loading screen.
- Otherwise the Lock card is replaced in place by a loading view: a progress bar and the name of the current step. Once shown, it stays at least 300 ms, so it never flickers.
- The bar is **real**. Each step has a fixed share of the bar. Inside a step the bar moves only on reported progress. It never creeps on a timer, unlike today's launch window.

| Step (new i18n key) | Progress source |
|---|---|
| `loading.opening` "Opening your data" | Not countable. Done when OS unseal + vault + DB open + quick probe have finished |
| `loading.migrating` "Updating your data" (only when `user_version` is below the latest) | Migrations i of n. Migrations that rebuild a table report rows copied of total |
| `loading.transactions` "Loading transactions" | Rows scanned of rows in the Overview's 14-month window (recurring and alerts inputs) |
| `loading.overview` "Preparing the overview" | Overview queries done of total (summary.month, accounts, alerts, budgets) |

Progress travels as `AppEvent::LoadProgress { step, done, total }` from the DB worker to the UI, at most 30 per second.

These are **not** loading steps; they run after the Overview is shown, in background tasks that can be cancelled:
- local insights tips
- sync pull and apply
- update check
- ECB rates
- other pages

**Responsive with big datasets:**
- **One DB worker thread** owns the connection. It has a two-level queue: visible-screen queries first, background jobs second.
- Background jobs (insights, recurring cache refresh, transfers.find, sync apply, backups) run in chunks of about 20 ms or 2k rows. They yield to the UI queue between chunks and are cancelled on lock, like `cancelRunningJobs` today.
- The UI thread never touches SQLite.
- **The Overview is computed first.** Other pages load on demand when opened. Their results are cached per data version, and the existing `data.changed` event invalidates the cache.
- **Transactions list:**
  - Shown in a Slint virtualised `ListView`, backed by a paged model of 200-row pages, keeping at most about 10 pages (LRU).
  - The op contract keeps `limit`/`offset` for parity.
  - Internally, deep pages use keyset seeks on `(booking_date, id)`. A differential test proves the results are identical to the offset version.
  - Totals for the whole filter come from one aggregate query, never from loaded rows.
- The import preview grid and the year/net-worth tables are virtualised the same way. No screen keeps all transactions in memory.

**Note for translators and implementers:** the four loading step names above (`loading.opening`, `loading.migrating`, `loading.transactions`, `loading.overview`) are new texts. They need keys in all 8 locale files. The progress bar is real: it differs from today's launch window, where the bar creeps forward on a timer between steps (the creep timer in `src/main/splash.ts`).

**Measurement hooks:** startup.log keeps its format, plus these milestones:
- `process start` (OS creation time), `main entered`, `prefs read`
- `window created`, `first frame painted`, `window shown`
- `device prompt requested`, `device prompt shown` (Windows: prompt window found), `device answered`
- `kdf done (ms)`, `db opened (ms)`, `migrations checked`, `first unlocked frame`
- `preload started` / `preload done`, renderer used (skia/femtovg/software), first start of this version

Derived lines are written once per start: `time-to-first-frame`, `time-to-prompt` (from `device prompt requested`, which is logged on button press, to `device prompt shown`), `time-to-unlocked`.
`KASBOEK_STARTUP_TRACE=1` adds per-phase timings to the log for development.

**Targets** (measured from process start, warm and cold, on Windows x64, Windows ARM64, macOS arm64, Linux x64):

| Measure | Target |
|---|---|
| First frame | ≤ ~0.5 s |
| Hello / Touch ID prompt visible (time from button press) | ≤ ~0.7 s |
| Unlocked after Hello success | ≤ 0.3 s plus DB open |
| Unlocked after password submit | KDF time + ≤ 0.2 s |

The first start after an install is reported separately, because Defender scans new unsigned files.
Fallback: a tiny in-process splash behind `--splash` / a pref, enabled only if measurements on some platform
miss the first-frame target. It is off by default.

## 6. Parity strategy ("make sure it works the same")

All inputs are **invented**: seeded generators for accounts, invented IBANs with valid checksums, fake
counterparties and amounts. Never real bank data. The owner may run the comparison tool on private files
locally; results and files are never committed.

1. **Differential core harness** (`parity/`):
   - `ts-runner.ts` runs scenarios against `src/core` under `ELECTRON_RUN_AS_NODE=1 electron` (the native module is
     built for Electron, like `npm test`). `kb-cli scenario` runs the same scenario in Rust.
   - A scenario is a JSON list of `{op, input}` steps on a fresh or seeded DB, with a fixed clock (`vi.setSystemTime`
     on the TS side, `Clock` on the Rust side) and seeded randomness.
   - Output: every op result plus a canonical DB dump (tables ordered by id; uids, IVs and created_at masked or
     normalised). The two outputs are diffed as JSON.
   - Suites: CSV import (generated files across delimiters, encodings with and without BOM, date orders, decimal
     marks, bank presets in `tests/fixtures`); CAMT 052/053/054 (generated XML incl. hostile inputs); PDF lines and
     statement from recorded `PdfText` JSON; rules (contains/word/starts/iban, priority, reorder); budgets, alerts,
     recurring detection over 14 months; insights facts and their order; month review; transfers find/pair across
     currencies; fx; goals/wealth/net worth/balances; password rules (`shared/password.ts`); IBAN parsing and masking.
   - The AI previews (`insights.preview`, `import.assistPreview`, `import.pdfAssistPreview`) return **the exact text
     sent to the model**, so they must be byte-identical. That is the masking guarantee.
2. **Cross-open tests** (CI on all 3 OSes, both arches where runners exist):
   - TS writes a DB, export, backup, sync change, state and snapshot files; Rust opens them, and the reverse.
   - Both sides do every migration path: open a DB created at schema 1..15 and migrate it.
   - Mixed-fleet sync: two DBs, one engine each, interleaved edits, deletes and clashes; both converge to the same
     dump and record the same conflicts.
   - Electron-seal fixtures: a tiny Electron 45 script writes account.json on each OS, and Rust decodes it.
3. **PDF extraction parity**:
   - Synthetic PDFs (`tests/helpers/make-pdf.ts`, `statement-pdf.ts`) plus generated layouts.
   - Compare pdf.js items with the hayro reader's items within position tolerances (done in spike C, section 10).
   - Then require identical `statement.ts` grids. Differences go into a normalising adapter in kb-pdf, never into
     the statement logic.
4. **UI screenshot and geometry parity**:
   - One fixture set (`parity/ui/<scenario>/<op>.json` + events) drives both renderers.
   - Electron side: Playwright (preinstalled, 1.63) loads `out/renderer/index.html` with
     `addInitScript` installing a stub `window.kasboek` that returns the fixtures, with a frozen clock.
   - Rust side: `kb-ui` with a FixtureService on the Slint software renderer, offscreen (Skia unverified).
   - Matrix: every page and modal × light/dark × en/de/fr (longest strings) × 1x/2x scale, at 1280×820.
   - Compared: (a) **geometry**: boxes of landmarks (nav items, cards, headings, buttons, table cells; existing
     `data-tour`/aria labels plus `data-testid` added on this branch only) against Slint element geometry through
     its testing API, within ±1 px for containers and ±2 px for text baselines; (b) **pixels**: pixelmatch/SSIM with
     anti-aliasing tolerance, under 2% changed pixels per page; (c) owner side-by-side review per screen.
   - Glyphs will never be bit-identical across rasterisers. Exactness is defined by (a) and (b).
   - Owner decision: for small native details (see section 0), the (a) and (b) thresholds are guidelines, not blockers.
5. **Porting the 863 vitest tests**: about 520 core/shared tests become Rust unit tests module by module (same
   names, so coverage can be tracked in a table). Tests of Electron glue (`ipc-wiring`, `splash-page`,
   `window-policy`, `device-auth`, `startup-*`) are rewritten against kb-platform, or dropped with a written
   reason. A `parity/coverage.md` table lists every TS test file and its Rust counterpart.
6. **Behaviour checks a machine can't do**: a per-screen checklist of keyboard focus order, Escape/Enter in
   modals, screen reader (Narrator, VoiceOver, Orca), IME dead keys (é ü ç ã ñ ß), drag and snap of the window,
   tray, notifications. Run at M4 and M7 on real hardware including Windows on ARM.

**7. Performance benchmark (`kb-bench`, invented data only).**
A seeded generator builds encrypted DBs with **10k, 100k and 500k transactions**. It includes 3, 8 and 20 accounts, multi-currency rows with FX rates, 30 categories, 50, 200 and 1,000 rules, budgets, splits, paired transfers and recurring patterns over 14 months. Fake counterparties and invented IBANs. It never imports real files.

It also builds one schema-1 DB at 100k rows to time the migrations.

Measured, from process start and from the unlock moment:
- time-to-unlocked (KDF reported separately)
- time-to-first-useful-screen (Overview with totals painted)
- Transactions first page
- p95 frame time while scrolling at full speed
- filter and search latency
- import commit of a 5k-row CSV
- sync flush and apply of 10k changes
- migrations time
- peak and steady RSS

The same scenarios run through the TS runner, so the Electron baseline is measured too.

Reference machines: one Windows ARM64 laptop, one 2020-era x64 laptop, one Apple-silicon Mac, one Linux x64 machine. The thresholds below are targets to confirm at M2, not promises:

| Dataset | Unlocked (excl. KDF) | First useful screen | Transactions first page | Scroll p95 | Filter/search | Peak RSS |
|---|---|---|---|---|---|---|
| 10k | ≤ 0.2 s | ≤ 0.5 s | ≤ 50 ms | ≤ 16 ms | ≤ 100 ms | ≤ 120 MB |
| 100k | ≤ 0.3 s | ≤ 0.8 s | ≤ 80 ms | ≤ 16 ms | ≤ 200 ms | ≤ 180 MB |
| 500k | ≤ 0.5 s | ≤ 1.5 s | ≤ 150 ms | ≤ 16 ms | ≤ 300 ms | ≤ 300 MB |

A migration from schema 1 at 100k rows must finish in ≤ 3 s and show "Updating your data" with real progress.

## 7. Roadmap

Estimates are for one experienced Rust engineer with agent help, counted in engineer-weeks (ew). Calendar time
depends mostly on owner review.

| Milestone | Scope | Exit criteria | Estimate |
|---|---|---|---|
| **M0 Spike** (time-boxed) | Slint shell + Lock screen + Overview on fake data; open an Electron-written encrypted DB and show real totals; Hello/Touch ID button in the first frame (prompt on press); renderer comparison (Skia vs FemtoVG vs software); CI builds for 6 targets | **G1** Overview geometry ±2 px and pixel diff ≤ 3% vs Playwright, light and dark, en and de. **G2** Inter with tnum and accents, Serif title; Narrator and VoiceOver read nav and buttons; Tab order matches. **G3** dead-key IME works. **G4** Rust opens a TS-written DB and TS re-opens a Rust-written one, on Win, mac and Linux. **G5** first frame ≤ 0.5 s and Hello prompt ≤ 0.7 s from button press on Win x64, Win ARM64 and mac arm64, logged in startup.log; installer ≤ 25 MB. **G6** decode an Electron-sealed account.json on Windows, with a written plan for mac and Linux | 2–3 ew |
| **M1 Foundations** | Workspace, kb-sqlite3mc-sys, kb-crypto, kb-db (15 migrations, `fx`), account and file codecs, kb-cli, TS runner, tools.json dump, CI matrix | All cross-open tests green on 6 targets; crypto/format unit tests ported | 4–6 ew |
| **M2 Core parity** | All 154 ops in kb-core/kb-import/kb-assistant (logic only)/kb-sync engine | Differential suites green; ~520 ported tests green; schema-dump equal | 10–16 ew |
| **M3 Design system** (parallel with M2) | Tokens, frozen fonts, 74 icons, primitives from `ui.tsx`, 4 charts with hover tips, Modal/Popover/Tooltip/Toast, title bar per OS, shell + nav, assistant panel frame | Component gallery passes geometry and pixel diffs (owner decision: the 3% and 2 px gates are guidelines for layout, colours, typography and component proportions; small native details are accepted and tracked in section 10, polish list); components have accessibility labels | 4–6 ew |
| **M4 Screens** | In order: Setup/Lock/ImportFlow/Recovered, Overview (+tips, bank balance), Transactions (+splits, rename, searches, CSV export), Import (CSV, mapping, preview, consent, PDF, XML, AI check), Budgets, Recurring, Goals, Year (+PDF report), Net worth, Settings (all sections, Claude, Memory, MCP, WebDAV), Welcome + Tour, Assistant panel (streaming, confirmations, suggestions, model picker) + MCP requests | Each screen: fixture matrix passes; manual checklist done; owner sign-off | 12–18 ew |
| **M5 Platform** (partly parallel with M4) | OS seal + legacy migration, Hello/Touch ID, idle/lock/suspend auto-lock, single instance + `--background`, tray, notifications, dialogs, theme following, startup.log, quarantine, backup scheduler, sync service + WebDAV, ECB fetch, MCP bridge (Go helper unchanged), updater (GitHub + SHA256SUMS, MSI via Go helper, AppImage replace) | Real-hardware checklist on 6 targets; security review closed; mixed-fleet sync with the Electron app | 6–9 ew |
| **M6 Installers** | MSI (WiX, same UpgradeCode, per-user, same path and exe, shortcuts, art), dmg (`app.kasboek`, ad-hoc or Developer ID), AppImage + deb (same name), `kasboek-mcp` in the same place, assets named for `pickAsset` | Electron → Rust upgrade by the in-app updater on all 6; downgrade to Electron keeps data (`account.electron.json`); installers ≤ 25 MB | 3–5 ew |
| **M7 Beta + cut-over** | GitHub pre-releases (the Electron updater reads only `releases/latest`, so it never sees them); owner dogfooding ≥ 4 weeks; merge to `main`, release as the next minor or 1.0; remove Electron code one release later | No open parity bugs of severity ≥ medium; start-up targets met on real machines; owner go | 4–8 ew |

- **M0 exit criteria**, add: **G7** On the 100k bench DB, the loading view appears only after 180 ms. It shows the real step names, and the bar matches the reported done/total. On the 10k DB, the Overview appears with no loading view.
- **M0 status** (Linux only, section 10): G1 partial, G2 partial, G3 unverified, G4 partial, G5 partial, G6 and G7 not run.
- **M2 exit criteria**, add: kb-bench runs nightly in CI on Linux x64 and macOS arm64, plus a weekly manual run on Windows x64 and ARM64. The thresholds above hold at 10k and 100k. A regression above 20% fails the run.
- **M4 exit criteria for Transactions and Import**, add: the 500k thresholds hold, including scroll p95 ≤ 16 ms and RSS ≤ 300 MB.
- **M7 exit criteria**, add: the full benchmark is met on all four reference machines, and the results are recorded in the release notes.

**Total: about 45–75 ew** (roughly 8–14 months of calendar time with parallel agents). Treat the low end as
optimistic.

**Top risks:**
1. "Exact copy" judged at pixel level cannot be met, because text rasterisation differs. Agree the geometry and
   pixel thresholds with the owner in M0.
2. Decoding Electron's safeStorage format (async OSCrypt; macOS Keychain ACL prompt; Linux kwallet).
3. sqlite3mc build or link parity on 6 targets, and later version drift.
4. Rust PDF reader vs pdf.js text segmentation changes PDF import results. Fonts without ToUnicode give no text (spike C).
5. Accessibility of custom components (tables, charts, tour) is weaker than Chromium's.
6. Custom title bar: Windows Snap Layouts and caption buttons, macOS traffic lights, Linux Wayland decorations.
7. `main` keeps shipping features: double work and schema drift. Freeze, or make each feature carry parity fixtures.
8. Mixed Electron/Rust sync groups during the beta.
9. ICU/Intl and `localeCompare` differences.
10. HTTP stack differences (system proxy, PAC, OS trust store) compared with Chromium `net`.
11. Linux desktop dependencies (tray, portal, Secret Service) and Wayland idle detection.
12. Owner review bandwidth.
13. SQLite aggregate queries at 500k may miss the targets with today's indexes (`idx_tx_account_date`, `idx_tx_category`). Any new index is a migration, so it must ship in both apps (schema lockstep).

**I would recommend stopping if:**
- Any of G1, G2 or G4 still fails one week after the M0 time box. In that case keep improving the Electron
  start-up instead. Switch to GPUI only if the owner accepts losing screen-reader support.
- G6 fails and there is no acceptable password/recovery-key migration UX.
- The start-up gain over a measured Electron 0.21.x is under 2× on Windows ARM64.
- M2 velocity at its midpoint projects more than 1.5× the upper estimate.

## 8. How the dev-team agents split the work (per CLAUDE.md)

The main conversation is the project manager. It sends each task directly to one specialist and combines the
reports; agents never start other agents. Every task names:
- the crate it owns,
- the TS sources it ports (path:line),
- its fixtures,
- its exit test.

One implementer per crate at a time. Workspace files (`rust/Cargo.toml`, the op macro table) change only in
dedicated integration tasks.

- **architect**: M0 spike design; the `AppService` and UI state design; renderer and title-bar choice; per-milestone
  notes. Each is short and sequential.
- **test-writer, first for every module**: creates scenarios and golden fixtures from the TS side and ports the
  module's vitest tests to failing Rust tests.
- **implementer**: ports the module until its tests and differential suite pass.
- **code-reviewer**: reviews every task.
- **security-reviewer (mandatory)**: kb-crypto, account and OS seal, the Electron-seal decoder, file and sync
  codecs, zeroizing and locking, the pdf child process, the MCP bridge (token, socket permissions), the updater
  (checksums, paths, helper plan), WebDAV, AI request bodies and masking, the start-up rule "nothing decrypted
  before authentication".
- **Performance benchmark and loading screen** (security-reviewer): progress events carry only step ids and counts, never data. That matches today's rule that startup.log holds only technical facts.

- **docs-writer**: keeps `docs/FORMATS.md` canonical (unchanged formats), updates README build/run instructions,
  release notes, `parity/coverage.md`. Follows the CLAUDE.md version rule for every installer build.

**Parallel lanes after M1:**

| Lane | Tasks that can run at the same time |
|---|---|
| A: core | finance+rules+budgets · recurring+alerts · insights+review · import-csv · camt · pdf lines/statement · fx+wealth+goals+balance · transfers · sync engine · memory/settings/account ops |
| B: UI | design tokens + fonts + icons → primitives → charts → shell, then screens one per task, once lane A has that screen's ops |
| C: platform | OS seal + legacy decoder · Hello/Touch ID + start-up pipeline · tray/notifications/idle · MCP bridge · updater · sync stores/WebDAV |
| D: CI/packaging | 6-target build matrix · sqlite3mc bundling · MSI/dmg/AppImage/deb · parity CI (Playwright + offscreen Slint) |

**Performance task (lane A):** "kb-bench generator + DB worker queue + paged model". test-writer builds the generator and thresholds; implementer builds the worker and model; code-reviewer reviews. Lane D runs the nightly benchmark.

**Sequential dependencies:**
- kb-crypto and kb-db come before account/session and before all of lane C's unlock work.
- The op table comes before UI wiring.
- Tokens come before screens.
- The Lock screen and start-up pipeline come first in lane B, because they are gate G5.

## 10. Spike results (M0, Linux only)

Run on Linux x64 (Xvfb for the UI start-up figures). Nothing was built for Windows, macOS or arm64. All data is
invented. Rerun steps are in `rust/spike/db/README.md`, `rust/spike/ui/README.md` and `rust/spike/pdf/README.md`.

**A. Database and crypto** (`rust/spike/db`)
- sqlite3mc 2.4.0 (SQLite 3.53.4) compiled from the `node_modules` amalgamation with the same 37 defines, linked
  into rusqlite 0.43 through a patched `libsqlite3-sys`. Open sequence as in `database.ts`: chacha20, hexkey.
- Electron-written DB (3 accounts, 28 categories, 96 budgets, 2,000 transactions, 24 tables, `user_version` 15):
  Rust reads the same counts and transaction sum.
- Rust-written DB opens with the app's `openDatabase`, non-ASCII text included. Wrong keys are rejected both ways.
- Password slot (Argon2id m=131072 KiB, t=3, p=4, NFKC, AES-256-GCM with the label as AAD) works in all four
  directions.
- Timing: DB open 26 ms (2,000 rows). Argon2id ~300 ms in Rust (argon2 0.5.3, lanes serial) vs ~490 ms hash-wasm.
- Spike binary 3.17 MB, of which about 2.4 MB is the DB engine.
- Not covered: Windows, macOS and ARM builds; scrypt, HKDF and recovery slots; the `fx()` UDF; sync triggers;
  WAL and `VACUUM INTO`.

**B. UI** (`rust/spike/ui`)
- Slint 1.19.0 (GPL-3.0 option), software renderer. Lock screen (password and Hello-button modes) and Overview
  (sidebar, assistant panel, charts), light and dark, English only.
- Against the Electron reference: landmark offsets 0 px; pixel diff 0.2% (lock), 0.8% (overview), 2.0% (overview
  scrolled, with trend chart). Threshold 3%. The rest of the diff is text anti-aliasing.
- Slint gaps handled by hand: no height-for-width (wrapped text and step-title heights are hardcoded for the
  fixture), no text-decoration, no dash arrays, no variable fonts (static instances needed).
- Fonts: 8 static TTFs, 474 KB, OFL-1.1. `cv11`/`ss01` do not exist in the shipped latin subsets; `tnum` is frozen
  into "Inter Num".
- Accessibility: the AT-SPI tree was checked on Linux. Custom components need an explicit role and label, and a
  TouchArea is not focusable (every control needs a FocusScope). Windows test 1 (Narrator on the first CI build):
  only the window title and the typing field were read, no button was reachable by Tab. Fixed in the spike, not yet
  confirmed on Windows: every control is a FocusScope with role, label and Invoke action, a 2 px focus ring,
  decorative icons are removed from the tree (`accessible-role: none` works on a plain Image, not on a component whose
  root is an Image), stat cards and chart summaries are single items; a CI step reads the window with UI Automation.
  Tab order checked offscreen (`shot --tab N`). VoiceOver, IME and dead keys were not tested.
- Size: 12.57 MB release binary (software renderer) for these two screens; femtovg 13.17 MB, skia 19.56 MB. 445
  crates; clean build 252 s.
- Start-up: 37–43 ms to first frame under Xvfb with the software renderer. That renderer has no first-paint hook,
  so the figure is timer-based. femtovg renders correctly but its first frame took 4.6 s under llvmpipe (an
  environment limit). Skia (GPU and software) hung here; unverified.

**C. PDF** (`rust/spike/pdf`)
- `hayro-interpret` and `hayro-syntax` 0.9.0 (MIT OR Apache-2.0, 64 crates, no C) plus ~200 lines of our own glyph
  merging that reproduces pdf.js item boundaries. Same limits and error codes as `extract.ts`.
- 33 invented files, 31 read by both readers: cells 99.9% equal, lines 99.9%, whole `readStatement` result equal
  on 31 of 31 (20 with a table; all table grids equal).
- Weak spots: Courier 92% of cells (statement equal); non-embedded TrueType with its own `/Widths` 50% on a tiny
  file; CID fonts without ToUnicode give no text where pdf.js reads them. That last one is the main real-world gap.
- Speed and memory: small files 1–3 ms and 6 MB vs pdf.js 30–80 ms and 110–120 MB; 71 pages 59–98 ms and 9–10 MB
  vs 333–416 ms and 157–166 MB. Adds about 5.4 MB to the binary (4.9 MB without the CJK CMaps).
- Hostile input: 3,338 files (338 hand-made or mutated, 3,000 mutants), 0 crashes, aborts or hangs. Gaps closed
  in the spike: a 2 GiB decompression bomb (1 GiB allocator cap, `import.pdf_too_large`) and the missing clock in
  the interpreter (device checks every 256 callbacks, plus a process deadline). pdf.js on the same set: 2,000,000
  nested `q` gave no answer in 90 s; the 2 GiB bomb used 4.3 GB.
- Rejected: pdf_oxide (merges spans across columns, 77.3% of cells), pdf-extract (no `/Rotate`, panics),
  pdfcraft (not on crates.io; same engine as hayro; a 150,000-line page ran over 90 s).
- hayro's `Device` API changed between 0.7 and 0.9: pin the version.

**Gate status**

| Gate | Status | Evidence |
|---|---|---|
| G1 Overview geometry and pixels | Partial (pass for en) | landmarks 0 px; diff 0.2% / 0.8% / 2.0% vs 3%; German not run |
| G2 Fonts and accessibility | Partial | fonts pass; AT-SPI tree and Tab order on Linux; Narrator found only the text field in test 1, fixed but not re-tested; VoiceOver unverified |
| G3 Dead-key IME | Unverified | not run |
| G4 Cross-open DB | Partial | Linux x64 both directions; Windows, macOS and ARM not built |
| G5 First frame, Hello prompt, installer size | Partial | first frame 37–43 ms (Linux, Xvfb); no Hello prompt test; UI binary 12.57 MB for two screens |
| G6 Electron-sealed account.json | Unverified | not in the spike |
| G7 Loading view at 100k | Unverified | not in the spike |

**Changes to the plan from the spike**
- PDF: pdfium dropped; hayro-based reader chosen (sections 0, 3, 4, 6, 7). Open: fonts without ToUnicode, and what
  replaces pdf.js as the fallback (it is JavaScript, so it needs a helper to be used from Rust).
- Fonts: the plan to freeze cv11/ss01 is dropped (section 2).
- Size: the 6–12 MB estimate for the app was too low. The UI binary alone is 12.57 MB, and the DB engine (about 2.4
  MB) and the PDF reader (about 5.4 MB) add roughly 8 MB more before the rest of the app. Simple addition of the
  measured parts, not a measurement of the full app. The 25 MB installer target is still plausible but with less
  margin.
- Effort: section 7 estimates are unchanged for now. M1 gains the vendoring of the amalgamation into
  `kb-sqlite3mc-sys` (the spike builds from `node_modules`), a pinned hayro, and a conformance suite ported from the
  TS `extractText` tests. Re-estimate at the M0 go/no-go.

**Next steps**
1. Owner real-file PDF check: run `PDF_DIR=<folder> rust/spike/pdf/tools/run-all.sh` locally. Nothing is copied or
   sent. Use the result to decide the ToUnicode fallback.
2. CI matrix (GitHub Actions) builds spikes A and B for Windows x64 and ARM64, macOS arm64 and x64, and Linux arm64.
   Download the artifacts and test first frame, Hello/Touch ID prompt on button press, IME dead keys, and
   Narrator/VoiceOver.
3. German and one long-string locale on the two UI screens (G1).
4. Cold-start and Defender first-run measurements (G5, section 5).
5. Go/no-go meeting for M1, using the gate table above.

**M1 progress (Foundations; Linux x64 only so far, CI for the other five targets is in `.github/workflows/rust-ci.yml`)**

Done:
- Workspace `rust/Cargo.toml` (resolver 2, shared versions, release profile with LTO, strip and abort on panic) and
  `rust/README.md` (layout, how to run, rules).
- `kb-sqlite3mc-sys`: sqlite3mc 2.4.0 / SQLite 3.53.4 vendored (no `node_modules` at build time), the 37 defines read
  from the vendored `defines.gypi`, licence files, `VENDOR.md` with versions, hashes and update steps. Patched in as
  `libsqlite3-sys` for rusqlite 0.43.
- `kb-crypto`: password slot (Argon2id, NFKC), recovery slot (HKDF `kasboek:slot`), legacy scrypt slots with the same
  caps, vault seal, TOTP (RFC 6238 vectors), recovery key format, base32/base64/hex, and the `.kasboek` (KASBOEK2) and
  `.kbsync` (KBSYNC1) codecs. Typed errors with the TypeScript codes; keys in `Zeroizing`.
- `kb-db`: `Store` trait and `SqliteStore` (open/unlock as in `database.ts`, transactions with savepoints, migrations
  1 to 15 with the same SQL, `fx()`, integrity check, `VACUUM INTO`, canonical dump). A test fails if the linked engine
  is not sqlite3mc 2.4.0.
- `kb-cli` and `rust/parity`: differential suite in both directions (databases at schema 1 to 15 including the
  migration paths, all slot kinds, vault, TOTP, `.kasboek`, `.kbsync`, `fx()`, wrong keys and refusals) and committed
  known-answer fixtures, read by both sides.
- CI workflow `rust-ci.yml`: release build, `cargo test`, clippy `-D warnings`, rustfmt check and the parity suite on
  the six runners.

Not done yet (still M1 or later):
- The six-target CI has not run: cross-open on Windows, macOS and ARM is unconfirmed (gate G4 stays partial).
- No change hooks or typed query helpers in `Store` (they come with `kb-core`); no `store-conformance` suite for a
  second engine; no `kb-bench`; WAL is not used (the app uses `journal_mode = DELETE`).
- Account logic (`account.ts`: throttling, remember-2FA MAC, unlock flows), `account.json` and the OS seal belong to
  `kb-core` and `kb-platform`. Time formatting (`toISOString`) is left to the caller of the codecs.
- Mixed-fleet sync, kb-core, kb-import, kb-pdf, kb-assistant, kb-sync, kb-i18n, kb-platform, kb-ui, the app binary.

Known differences from Node, none reachable with files the app writes: AES-GCM IVs other than 12 bytes are refused
(Node accepts them); invalid base64 characters are refused (Node skips them); the `fx()` function takes the text
arguments of non-text values as JavaScript would only for integers, reals, NULL and blobs.

**M2 progress (core parity, first slice; Linux x64 only, the six-target CI has not run it)**

Done (`rust/crates/kb-core`, plus typed queries in `kb-db`, `kb-cli scenario` and the scenario harness in `rust/parity`):
- Registry and `dispatch(core, op, input_json, actor)` as `ipc.ts` / `ops.ts` do it: the locked refusal with `PUBLIC_OPS`, `op.unknown`,
  input validation like zod (strict objects, safe integers, trim before length, code-point lengths, defaults, `null` only
  where the schema says so, all `op.invalid_input`), the audit log for `mutates` ops (the parsed input in schema order, redacted
  for `auth|transfer|backup|prefs|insights`), `AppError {code, message, details}`, `Actor`, injected `Clock` and `Rng`. Results are
  JSON with the TypeScript field names; whole floats print as integers (`100`, not `100.0`), like JavaScript numbers.
- All 154 ops are in the table with their flags. `rust/parity/dump-contract.ts` writes `crates/kb-core/contract.json` (names, mutates /
  assistant / public, descriptions, input JSON Schemas as `assistantTools()` makes them, the names of the output types, the
  enums, defaults and the currency list of Node's ICU). A Rust test fails when the table differs from it, and when an operation
  is neither ported nor answering `op.not_ported`.
- Ported (30): `accounts.list/create/update`, `categories.list/create/update`, `settings.get/update`, `prefs.get/update`,
  `searches.save/delete`, `transactions.list/create/update/edit/splits/split/rename/categorize/delete`,
  `balances.list/set`, `valuations.list/set/delete`, `fx.status/rates/setRate/deleteRate`. Also `reset_imported_settings`
  (the `UNTRUSTED_AFTER_IMPORT` reset) as a function; it has no op of its own.
- Not ported (124, `op.not_ported`): everything else, among them the transfers pairing (`transfers.*`), rules, budgets, summaries,
  goals, memory, insights, recurring, alerts, import, sync, auth, backup, assistant, mcp, update and export ops, and
  `fx.updateEcb`. `transactions.create` already applies the rules (the first matching rule in rule order, accents and case
  folded), because the TypeScript one does; rules can only be inserted as rows until the rules ops are ported.
- `kb-db` gained `Queries` (typed reads and writes, all SQL of these ops, no logic), `Store::transaction` with the caller's
  error type, `DbError::Unique`, `dump_tables` and `execute_script` (harness seeding). `kb-core` contains no SQL.
- Scenario harness: a scenario is `{name, clock, languages, prefs, steps: [{op, input, actor}]}` with harness steps `@lock`,
  `@unlock`, `@sql`, `@fxReload`, `@resetImportedSettings`. `rust/parity/scenario-runner.ts` runs it through the app's own
  `dispatch` from `src/main/ipc.ts` (Electron, tray, splash and session mocked) on a fresh encrypted database with the clock
  fixed (`TZ=UTC`); `kb-cli scenario file.json` runs it in Rust. Every result and a dump of all tables (uids and `*_at`
  columns masked) are compared; the message text of `op.invalid_input` and `op.failed` is not. 67 scenarios (every ported op,
  validation, locked, not found, Unicode, number and date edge cases) and a seeded household of 2,000 transactions with splits,
  three currencies, rules and edits, followed by about 200 list calls (filters, search, paging, totals) compared page by page.
- Differences found and fixed while building it: serde reads a struct from a JSON array (now refused, as zod does); zod 4 counts
  string lengths in code points, not UTF-16 units; a harness-only trap (the exchange-rate cache of `src/core/fx.ts` is module
  state, so the harness loads the whole app module graph again per scenario).

Deviations and what is not faithful:
- The message of `op.invalid_input` is serde's, not zod's `prettifyError` text (the code is equal). The message of `op.failed` is
  the same fixed text, the engine's own error stays out of it.
- `\p{L}\p{N}` in the whole-word rule match is Rust's alphabetic and numeric properties; the Unicode version of the NFKD and
  mark tables is that of the `unicode-normalization` crate, not Node's ICU. Both are the same for all text of the scenarios.
- `prefs.json` with a top level that is not an object counts as empty (TypeScript would spread a string or array into index
  keys); `null` fails with `op.failed` as in TypeScript. `prefs.update` does not apply the theme or tray (platform glue).
- Time is UTC in the scenarios; `Clock::utc_offset_minutes` carries the person's offset in the app (`localToday`).
- The currency list is the committed table from Node's ICU (`contract.json`); it follows the Node that regenerates it.
- Output types have no runtime schema in TypeScript (`out<T>()`), so `contract.json` holds only their names; outputs are checked
  by the scenarios.
- `hideAccountNumbers` (named in the task) is not a setting of this code base.

Not confirmed (needs the CI on Windows and macOS): the parity suite and `cargo test` on the other five targets, line endings of
the scenario files under Windows checkouts, `TZ=UTC` taking effect in the Node of those runners, and the file replace of
`prefs.json` (`rename` over an existing file) on Windows.

**M2 progress, slice 2 (rules, budgets, summaries, alerts, goals, recurring, transfers, net worth; Linux x64 only)**

Done (`rust/crates/kb-core`, typed queries in `kb-db`, 64 new parity scenarios, a longer household):
- Ported (25, so 55 of 154 operations now): `rules.list/create/preview/update/reorder/delete`, `budgets.list/set/copyPrevious`,
  `summary.month/year/review`, `networth.summary`, `alerts.list`, `goals.list/create/update/delete`, `recurring.list/hide`,
  `transfers.find/pair/unpair/cost/setCost`. The remaining valuations ops were already in slice 1. Rule matching (contains, word,
  starts, iban, priority), the `effectiveMatch` rule (short "contains" texts become whole-word rules), `groupKey`, the exchange cost
  and the fee split of a cross-currency pair follow the TypeScript functions one to one; error codes are the same. The last
  recurring scan is kept per database with the key `today|total_changes()`, as in `recurring.ts`, and dropped when the store changes.
- All SQL is new `Queries` methods in `kb-db` (statements copied, including `INCOME_SQL` / `SPENDING_SQL`, the `tx_lines` view and
  the order of the rules), so the engine returns rows in the same order as for the TypeScript core. `kb-core` has no SQL.
- Scenario harness: the random `transfer_pair` keys (8 random bytes in TypeScript, `Rng` in Rust) are numbered in order of first
  appearance in the table dumps of both sides, so which rows share a pair is compared. 64 new scenarios (rules in every mode with
  accents, case, iban and priorities, budgets near, at and over the limit, refunds and transfers kept out of spending, splits,
  month and year boundaries, leap days, December to January, other currencies and missing rates, recurring detection over 14
  months with a price change, double charges, weekly, quarterly, yearly and month-end payments, late and due statuses, hide and
  show, cache behaviour, alerts on three different clocks, goals, net worth ranges, transfers within and across currencies with
  bank cost, errors and rollbacks, locked refusals). The seeded household now adds 14 months of fixed payments, 18 own transfers
  (6 across currencies), rules, budgets, goals, and compares `summary.month`, `.review` and `budgets.list` for each of 24 months,
  `summary.year`, `networth.summary`, `recurring.list` (also after hide and show), `alerts.list` and `transfers.find/pair/cost`.
- Ported TypeScript unit tests: `rust/crates/kb-core/tests/slice2.rs` (22 tests from `finance`, `features`, `recurring-hide`,
  `recurring-cache` and `wealth`), plus unit tests of the date helpers, `groupKey` and the goal months.
- Differences found and fixed while building it: `addMonths` of the TypeScript core goes through `new Date(y, m, 1)`, which reads
  the years 0 to 99 as 1900 to 1999 and prints years without leading zeros (`0001-01` minus 5 months is `1900-08`); `monthRange`
  uses it too. The word-boundary and `groupKey` letter test now follows `\p{L}` more closely (no combining marks, letter numbers or
  circled letters, which Rust's `alphabetic` adds). Not an operation difference: a scenario of `op.not_ported` answers cannot run
  through the differential suite (TypeScript answers them), so that is a cargo test.

Not faithful (kept, none reachable with data the app writes):
- `\p{L}` and `\p{N}` come from Rust's Unicode tables, not Node's ICU (the same for all text of the scenarios).
- `slice(0, 60)` counts UTF-16 units. A cut through the middle of a surrogate pair drops the whole character, where JavaScript
  keeps a lone surrogate that a Rust string cannot hold (names of recurring items, rule preview examples, review).
- `Date.parse` is read only for `YYYY-MM-DD` (month 1 to 12, day 1 to 31, `2026-02-30` is 2 March, like V8). Other shapes give
  NaN here; V8's legacy parser reads more.
- `transfers.find` sorts with a merge sort that gives the stable order of JavaScript's sort even when a date does not read (NaN
  days); `groupKey` leaves out the "message" part for transfers between people (only imports use it; they come with `kb-import`).
- The fee-category search by name uses lower-casing, JavaScript uses the regular expression's own case folding; the same for all
  letters of the languages Kasboek has.
- `rules.create`, `transfers.pair` and the others write through `Store::transaction`; an engine error other than a unique clash is
  `op.failed`, as in TypeScript, with the engine's text left out.

Not done in slice 2 (op.not_ported, 99): memory, insights, import, export, sync, backup, assistant, mcp, update, app and `auth.*` (the
last in `kb-session`), `fx.updateEcb`.

Not confirmed (needs the CI on Windows and macOS): `cargo test` and the parity suite on the other five targets; the transfer pair keys
use 8 random bytes from the injected `Rng` (the app must supply a real one).

**M2 slice 3a: kb-import (CSV and CAMT import engine; Linux x64 only, the six-target CI has not run it)**

Done (`rust/crates/kb-import`, `kb-core::import` and `ops/import.rs`, new `Queries` in `kb-db`; 68 of 154 operations ported):
- `kb-import` (no storage): CSV decoding with `encoding_rs` as `TextDecoder` does it (UTF-8 with and without BOM, UTF-16 LE/BE with BOM,
  else Windows-1252; a BOM of the chosen encoding is dropped, also a second one), RFC 4180 parser, delimiter detection, header row, the synonym
  tables of 7 languages, `autoMap`, date order and decimal detection, bank layout labels, `normalizeRows` (debit/credit, direction column,
  `invertSign`, named months, OGM, references), `parseAmount`, the fingerprint, `groupKey` (now with the "message" part for transfers
  between people; `kb-core` calls it), `build_rows` (ready / duplicate / possible duplicate / problem / skipped, `Ledger` trait for the
  account's existing rows, learned names), `file_balance`, reconciliation. The CAMT reader has its own safe XML parser (DOCTYPE refused,
  five entities and character references, depth 64, 2,000,000 elements, no recursion) and `read_camt` with every review fix of the
  TypeScript reader (CLBD only as closing, group by IBAN, counterparty by IBAN comparison, batch splitting, row budget, 20 MB).
- `kb-core`: one open import per account in `Core` (cleared on lock), the 13 operations `import.analyze`, `.analyzeXml`, `.preview`,
  `.current`, `.raw`, `.remap`, `.updateRows`, `.commit`, `.checkApply`, `.checkUndo`, `.discard`, `.batches`, `.undo`. Left as
  `op.not_ported`: `import.analyzePdf`, `.pdfCancel` (PDF, `kb-pdf`) and the assistant ones (`.assist*`, `.pdfAssist*`). `checkApply` and
  `checkUndo` answer what TypeScript does when no check exists (the check itself comes with `kb-assistant`). `kb-db` gets `csv_profile_*`,
  `import_*` (by fingerprint, by reference, nearby, tidied) and `batch_*` queries; `rusqlite` now has its `cache` feature.
- Header floor (privacy): the session remembers the header row found on opening; for the assistant `import.remap` refuses a header row above
  it (`import.header_above`), `import.raw` and the previews leave out everything at or above it. This rule is NOT in the TypeScript of this
  branch (it is commit 0f68857 on `claude/focused-pasteur-oeugzy`, which also changes `import.raw` to `preambleLines`); it is ported from that
  commit for the assistant actor only and tested in `kb-core/tests/import.rs`, not differentially. The person's own calls keep this branch's shapes.
- Harness: `parity/compare.ts` (shared comparison), `parity/import-data.ts` (invented files), `parity/import.spec.ts` (see below). `"$session"` in a
  step input stands for the latest `sessionId`; `sessionId` and `committedAt` are masked.
- Differential tests: 104 tests, 100+ scenarios (comma, semicolon, tab and pipe files; Belgian, Dutch, German, French, UK and US formats; 10
  bank layouts; quoted and multi-line fields; BOM, UTF-16 and Windows-1252; thousands marks; negative forms; debit/credit and direction
  columns; bad rows; duplicates across files, n-th copies, pending-then-booked, possible duplicates; rules and learned names; remap and
  updateRows errors; saved and damaged layouts; balance columns; transfers paired at commit; batches and undo; CAMT 052/053/054 with batches,
  reversals, versions, namespaces, encodings, hostile DTD/entity/attribute inputs, limits of 50,000 rows, 2,000,000 elements, 1,000 statements,
  20 MB, 10 MB) and two seeded big files (50,000 CSV rows, 40,000 XML entries), all equal on results and database dumps.
- Ported unit tests: `kb-import` (parsing helpers, amounts, XML reader, dates, reconciliation) and `tests/camt.rs` (reader, limits, encodings).
- Differences found and fixed while building it: `Number(text)` reads hex, exponents and blank text, so dates such as `0x10-03-2026` are valid
  (a `js_number` port); names of `Object.prototype` (`constructor`) in a date make it invalid; attribute names `__proto__` are dropped and
  `Object.values` orders integer-like keys first (the namespace check reads that order); the engine's date parser reads February 30 as 2 March
  but throws on month 13, so `updateRows` with such a date is `op.failed`; `Buffer.from(text, 'base64')` skips junk and stops at `=`; more than
  six description columns make `mappingSchema.parse` throw in `autoMap` (`op.failed`); an XML with exactly 50,000 entries is refused by the
  50,000-row cap because the header counts.

Not faithful (kept):
- `x-user-defined` as a declared XML encoding is refused (Node's ICU has no table; Electron would read it).
- Doubles: sums (`inCents`, reconciliation) are f64 as in JavaScript; amounts are `i64`, equal for every value the app can hold (up to 2^53).
- The text of `op.failed` and `op.invalid_input` is not compared (as everywhere); `\p{L}` / `\p{M}` / `\p{N}` use the `regex` crate's Unicode tables.
- The assistant's header-floor shapes (above) have no TypeScript counterpart on this branch.

**M2 slice 3b: kb-pdf (PDF text reader and statement logic; Linux x64 only, the six-target CI has not run it)**

Done (`rust/crates/kb-pdf`): the spike C reader and the TypeScript PDF logic as one crate, not wired into the app yet.
- Reader (`reader.rs`): hayro-interpret / hayro-syntax `=0.9.0` (no embedded CJK CMaps: pdf.js, as `extract.ts` calls it, has no cMapUrl either), `PdfText` in the
  exact shape of `extract.ts` (shown page size after `/Rotate` and crop box, upright text, ligatures as letters, pdf.js gap rules), limits 150 pages / 100,000
  pieces / 1,000,000 UTF-16 characters / 60 s, the four error codes with the English messages. `process.rs`: `run_reader_process()` (the `--pdf-reader` child:
  stdin bytes, JSON lines on stdout as in `protocol.ts`, progress per page, 60 s watchdog, panic hook that answers `import.pdf_broken` also under
  `panic = "abort"`) and `read_pdf_in_child()` (parent side: empty environment, `isPdfText` checks, timeout, cancel flag, kill). `cap.rs`: `CappedAlloc`, a global
  allocator the app installs (`#[global_allocator]`), counting only after the child switched it on, 1 GiB.
- Logic: `lines.rs` (toLines), `statement.rs` (readStatement: tables, header recognition, repeated headers and margins, carry-forward lines, yearless dates,
  block layouts, IBAN column, other-account note, balances; `reconcile`, `runningMismatches`, the flip hint `reconciliationBanner`), `plan.rs` (the text sent to the
  assistant: `firstLineSent`, `maskedLines` with kb-rules `mask_numbers` / `mask_iban`, `splitParts`, `splitPart`, `partText`, `lines_to_send`, `preview_text`),
  `session.rs` (`analyze_pdf`: the grid and the `PdfSessionData` that kb-import's `analyzeGrid` takes). The CSV pieces `statement.ts` uses (parseDate, parseAmount,
  detectDecimal, headerField, `reconcile` with its f64 sums) now come from `kb-import` (kb-pdf depends on it; the private copies `csvrules.rs` / `synonyms.rs` are gone);
  `kb-pdf/tests/csvrules.rs` compares them with the TypeScript (`csvrules.json`). `is_js_space`, `utf16_len`, `js_round` and the `\s` class live once in `kb-rules`.
  `read_guarded` exists only for tests and the `parity` driver; the reader process shows its own message per error code, and a reader that cannot be started is
  `import.pdf_reader_unavailable`, not a damaged PDF (kb-service must word that code).
  Not ported: `parsePdfPlan` and `applyRowsPlan` (reading and checking the assistant's answer), they belong to the assistant crate.
- Tests: 35 in Rust (reader, errors, limits, rotation, protocol checks, 21 TypeScript fixtures for lines / statements / assistant text, CSV rules, plan, process
  tests against the real binary with `--features parity`, 30,000 seeded mutants), parity spec `rust/parity/pdf.spec.ts` (needs `cargo build -p kb-pdf --features parity`, `KB_PDF_BIN`).

Results (invented data only):
- Differential, 63 PDFs (38 from the repo helpers and generated statement variants in `rust/parity/pdf/corpus.ts`, 25 from the spike generator `gen_py.py`: reportlab and by hand): the Rust
  logic on pdf.js's text gives lines, cells, statements and assistant text **identical** to the TypeScript in 63 of 63 (exact numbers). Rust reader against pdf.js: page sizes and error codes
  equal in all; cells equal in 60 of 63 (the 2 below, and 1 where Rust is right and pdf.js garbled); statements read from the Rust reader's text equal in 63 of 63. Remaining differences: `rl_courier` (a space is exactly 0.6 em, pdf.js
  rounds either way; statement equal), `raw_differences` (non-embedded font whose `/Widths` differ from the substitute font: hayro stretches glyphs to the PDF width, so a word is cut;
  real Arial / Times metrics do not show it), and `raw_cid_no_tounicode` (below, Rust is the better one).
- Fonts without ToUnicode: the spike's statement that pdf.js reads them was wrong. For a CID font with Identity-H and no ToUnicode pdf.js returns **garbled text** (glyph numbers as
  characters, no error), so the TypeScript import finds no table. The Rust reader recovers the text from the embedded font program (`recover.rs`): glyph id, as hayro resolved it
  (also through `CIDToGIDMap`), reversed through the font's cmap, else the `post` / CFF glyph names (`uniXXXX`, Adobe names of Latin text). Measured on 6 generated files
  (`gen_cid_matrix.py`): Identity CID font 1/1, `CIDToGIDMap` stream 1/1, no cmap but glyph names 1/1, simple symbolic TrueType 1/1 for ASCII (codes above 127 come out through hayro's
  default encoding: wrong accents), font with neither cmap nor names 0/1 (answered `import.pdf_scanned`; pdf.js gives garbage there too). Bare CFF programs and OpenType-CFF were not tested (no
  fixture font in the repo); Type3 fonts are not recovered.
- Hostile: 3,338 files (38 hand-made, 3,300 mutants; `rust/parity/pdf/gen_hostile.py`, `run_hostile.py`) through the release reader process: 0 crashes, aborts, hangs or panic messages. 1,636 read, 569 broken, 1,128 scanned,
  5 too large. The 2 GiB bomb answers `import.pdf_too_large` in 0.4 s; the exponential form ends at the 60 s deadline. In cargo: 30,000 seeded mutants (xorshift, no cargo-fuzz), 0 panics.
- Binary: the reader plus logic add about 6.0 MB to a stripped release binary (LTO, `panic = "abort"`), about 1 MB of it regex and unicode tables that kb-import will share.
- Assistant text: ported from the release branch (`linesToSend`, `laterPageLines`, commit 0f68857): only table rows are sent, the first page from the header (else the first transaction-like line),
  later pages from their first transaction-like line, so a repeated holder name or address is not sent and a later page without a transaction is dropped; `assistant.pdf_no_table` replaces the
  8-line guess. The parity spec compares with that TypeScript (`KB_TS_ROOT=<release checkout>`, since this branch's `src/` is behind it). Masking uses `kb_rules::mask::mask_private`; the assistant text equals the TypeScript on all 63 PDFs, including `ts_turned12`.
- Only CI can confirm: the other five targets, Windows (`CreateProcess` with an empty environment, stdin/stdout pipes), macOS, the memory cap under real RAM limits, real bank PDFs.

**M2/M5 progress: kb-session (account and session; Linux x64 only, the six-target CI has not run it)**

Done (`rust/crates/kb-session`, README there):
- Ported behaviour for behaviour: `core/account.ts` (AccountData v2, slots, vault, attempts and throttle 5 free tries then
  30 * 2^(n-5) s up to 15 min, remember-2FA MAC for 30 days, unlock with password / device key / recovery key, change password,
  passwordless switch, new recovery key, 2FA on and off), `main/session.ts` (setup / locked / unlocked, `status()` shape, `lock()` that
  drops and zeroizes the keys, auto-lock hooks, reauth, erase and restore, adopt), the `account.json` file format behind an `OsSeal`
  trait (`FileSeal` for tests, `Unsupported`), `quarantine.ts`, the legacy `keystore.json` migration, the password rules, and the
  `auth.*` ops as `register_ops()` handlers for kb-core (`status`, `setup`, `unlock`, `unlockRecovery`, `lock`, `erase`,
  `restoreErased`, `changePassword`, `usePasswordless`, `newRecoveryKey`, `forgetComputer`, `totpBegin/Enable/Disable`, plus the aliases
  `exists`, `reauth`, `recover`, `switchToPasswordless`). Time and randomness are injected.
- Spike G6, offline part: the read-only Chromium OSCrypt decoder (Windows `v10` AES-256-GCM with the `Local State` DPAPI key, macOS
  `v10` AES-128-CBC with the Keychain password, Linux `v11` keyring and `v10` "peanuts"), tested with Node-made fixtures. The OS key
  retrieval is the `OsKeyProvider` / `Dpapi` traits.
- Tests: 31 in Rust (unit, 20 session scenarios on an encrypted database, 5 decoder), 17 parity cases (`rust/parity/session.spec.ts`): the
  TypeScript session (Electron, device check and clock mocked) and the Rust driver run the same scripts (setup, lock, unlock ok and
  failed with the throttle timing on an injected clock, recovery, 2FA with a fixed clock and 30-day remember, password change,
  passwordless switch, erase / restore / purge); every status and error code is compared, and so is the decrypted `account.json`
  (salts, IVs, ciphertexts and keys masked); files written by one side open on the other; password rules on 32 strings.
- Difference found and mirrored: an empty password at unlock makes hash-wasm throw, so the app answers `op.failed` and counts no
  attempt (the Rust side returned `auth.failed`).

Stubbed: the real OS seal (DPAPI, Keychain, Secret Service), the Windows Hello / Touch ID prompt (`DeviceAuth` trait, `NoDevice`,
`FakeDevice`), the QR code of `totpBegin` (hook, empty by default). Not verified: the async format of Electron 45's `safeStorage`
against the documented prefixes (needs a real file per OS), `seal:'os-native'` re-sealing, the other five targets.

Security review fixes: a device account is sealed again on every path that ends without an open database (guard object), recovery checks the
throttle before the seal is opened, `save()` refuses a device slot without the OS seal, a stale `lastAuth` cannot lock out the password,
`reauth` needs an unlocked session, `UnlockInput`/URI/CBC buffers are zeroized. Hardening the TypeScript lacks, on purpose: a remembered-computer
date more than 30 days ahead is refused and the throttle never waits longer than its delay for a future `lastFailedAt`. The parity driver needs
`cargo build -p kb-session --features parity` (the CI build step for the parity suite must add it).

Deviations: a device account stays OS-sealed until the device prompt succeeded when start-up is given the `lastAuth` hint (plan
section 5; the TypeScript opens it at start-up); `op.invalid_input` texts are not zod's; `slots` key order is fixed. The contract has
no `auth.device*` ops and no `mode: none` (`none` is only a seal); the device check lives inside `unlock`, `setup`, `usePasswordless`
and `erase`.

**M3 progress (design system `rust/crates/kb-ui`; Linux x64 only, `.github/workflows/rust-ui.yml` has not run)**

Done:
- Tokens (light/dark, runtime switch), fonts from one config (`tools/fonts.json` -> `make-fonts.py`, Kasboek Sans = Lato 2.015, Kasboek Display = Playfair Display, OFL texts), 74 lucide icons from the renderer's imports (`make-icons.mjs`), `Icon`.
- Components: Button, IconButton, Card, CardHeader, PageHeader, Field, Input, PasswordInput (hold to show), CodeInput, Select (popup, keyboard, type-ahead),
  Segmented, Switch, Checkbox, RadioGroup, Badge, EmptyState, Modal and ConfirmDialog (focus trap, Escape asks, backdrop does not close), Popover, Tip/HoverTip,
  ToastHost, MonthNav (+ picker), DateInput, Tabs, virtualised ListView, Scrollbar, Table rows, Meter, ProgressBar, Spinner; charts CategoryBars, MonthBars,
  TrendLine with hover tips and text alternatives.
- Gallery (`kb-ui-gallery`, `--shot` offscreen, `--tab N`, `--keys`), `tools/parity.sh` against the real React components, AT-SPI dump, UIA script, behaviour tests.
- Parity (21 cases with a React twin, light and dark): differing pixels 0.0 to 4.2 % (16 of 21 under the 3 % gate); landmark offsets
  0 to 2 px for 12 cases. Over a gate: pixels in password (Slint's fixed `●` mask), select (native arrow vs our chevron), date, badge (3.07 %), pageheader;
  landmarks in date (6 px), pageheader (5 px), monthnav (8 px), toast (6 px), and landmark count in input/password/select/segmented
  (the pixel analysis merges or splits faint disabled controls differently).
- Owner decision on the over-gate items: the 5 components over the 3% pixel gate (password, select, date, badge, pageheader) are **accepted, polish later**. Their remaining differences are the small native details listed in the polish list below.

**M4 progress (first screens, `rust/apps/kasboek`; Linux x64 only, `.github/workflows/rust-app.yml` has not run)**

Done:
- `kb-service`: `AppService` (`invoke(op, json)` as a future, event subscription with the `AppEvent` types of the contract plus `LoadProgress`),
  `FixtureService` (invented household of the release screenshots, JSON in `rust/apps/kasboek/fixtures`, demo password `correct horse battery 12`,
  throttle after three wrong tries) and `CoreService` (`kb_core::dispatch` on a real encrypted temporary database, one worker thread owns the
  core; ops that are not ported answer `op.not_ported`). Login of both is a stand-in until `kb-session` is wired in.
- `kb-rules`: `password.ts` and `iban.ts` ported (`check_password`, `valid_iban`, `mask_iban`, `find_ibans`, `mask_numbers`), compared with the
  TypeScript functions on 60 inputs (`tools/gen-fixtures.mjs`). `mask_account` / `shown_account` are new (the renderer has no such functions).
- `kb-i18n`: i18next-compatible lookup (dotted keys, `{{x}}`, plural suffixes with `_zero`, regional fallbacks, English last) for the 8 locales;
  2,208 cases compared with i18next 27 (`tools/gen-fixtures.mjs`). New texts live in `crates/kb-i18n/locales/extra.<lang>.json`, merged at load.
- App shell as in `App.tsx` (sidebar with icons, active state, Settings, Lock, version; top bar with the assistant toggle; placeholder pages and
  assistant note), Lock (password and device mode, recovery, erase, error, throttle countdown, in-place "Unlocking…"), Setup skeleton (choose,
  password with strength meter and rules, recovery key), loading view with real progress (180 ms / 300 ms gate, shares 10/20/40/30 %), Overview
  (month nav, stats, alerts, Suggestions with "Show exactly what is sent", category bars, accounts with hold-to-show eye, 6-month bars,
  uncategorised and unconverted rows). Light and dark; title bar colours on Windows 11 (DWM) and system theme detection; startup.log milestones;
  `lastAuth` cache for the first frame; Hello / Touch ID prompt only on the button press (code from the spike, not built on Windows or macOS here).
- Parity against the Electron stills (1440x900 at 2x): Lock 0.49 % pixels, landmarks 1 px (PASS); Overview 2.6 % pixels (under 3 %), landmark
  offsets up to 4 css px (month navigation 4 px wider, stat cards 1.5 px, from the polish list items MonthNav and PageHeader), one extra landmark
  (the eye in the Accounts header). AT-SPI dump: every control of Lock and Overview is a named, focusable item.

Not done: Welcome, Tour, the assistant panel, every page but the Overview, the Setup import and 2FA steps, toasts from real operations,
window blur hides revealed secrets (only locking does), month names in other languages, German and other long-string checks of these screens,
transparent title bar on macOS. Needs Windows or macOS: Hello / Touch ID, DWM title bar, Narrator / VoiceOver, IME, the build of `titlebar.rs` and `device.rs`.
The window is not created hidden: Slint 1.19 has no first-paint hook for the software renderer, so "first frame" is a timer after `show()`.

**M4/M5 progress: the app on real accounts and data (Linux x64 only; Windows and macOS not run)**
- `kb-service` `CoreService` v2: one worker thread owns a `kb-session` `Session` and a `kb-core` `Core` on the data folder. `auth.*` ops come from
  `kb_session::ops::register_ops` (contract names only), everything else from `kb_core::dispatch`. Rules of `ipc.ts`: `app.*` / `prefs.*` go ahead of the
  session (own preferences core on `prefs.json`), every other op waits for the account file to be read (queue order), locked refusal except `PUBLIC_OPS`.
  The session opens the database with the vault key; the core opens a second handle (no migration) and both are dropped on lock. `LoadProgress`:
  `opening` and `migrating` from the service (migration reported as a whole: 0 of 15, then 15 of 15, because the session migrates inside its open call; a per-migration
  step needs a progress hook in `kb-db`/`kb-session`), `transactions` and `overview` from the app's fetch. Idle timer (`autoLockMinutes` of prefs, every 15 s;
  system idle time through the `OsEvents` trait, else time since the last service call or `AppService::activity`), lock on system lock/suspend through
  `OsEvents` (stub `NoOsEvents`: no platform code yet). `lastAuth` is written to `prefs.json` after every `auth.*` call (the lock screen of the next start; also feeds
  the `Hint`, so a passwordless account stays sealed until the device check). Data folder = Electron `userData` (`--data-dir`, `KASBOEK_DATA_DIR`).
  Throttle seconds travel in the error `details`. No change to kb-core was needed (the `auth.*` ops are dispatched by the service).
- App: `--service core` is the default when a data folder is given (`--data-dir`, `KASBOEK_DATA_DIR`) or the Electron folder exists and `kb_oseal` says the OS can seal it (else a message and exit 2) (fixture flags and `--service fixture` keep the fixtures; `core-temp` = seeded
  temporary database). Setup: password with meter and repeat, passwordless, recovery key with the "saved" box and 4-character confirmation
  (`setup_rules.rs` = `recoveryKeyConfirmed`), 2FA step with QR (`qrcode` 0.15, MIT/Apache-2.0; SVG in `qrSvg`, drawn in Slint from runs of modules) and
  6-digit code, import option disabled with "not available yet". Lock: password, recovery key, 2FA code, remember 30 days, throttle countdown, Hello / Touch ID through
  `DeviceAuth` (`SessionDevice` wraps `device.rs`; the session asks during `auth.unlock`), erase with typed word. Settings -> Security (change password, passwordless,
  new recovery key, 2FA on/off), Accounts page marked "Developer preview" (`accounts.create`, `transactions.create`). Overview runs on real ops; sections whose op is
  not ported show their own "not available yet".
- Tests: `kb-service/tests/core_service.rs` (setup, lock, five wrong tries and the throttle, unlock, refusals while locked, change password, recovery unlock, 2FA with
  remember, idle and system lock, erase, second start); `tools/startup-test-core.sh` (hidden `--demo-setup`: account created, unlocked first frame time logged, second start
  unlocks, third start stays locked, password in no file); `tools/a11y-flow.sh` drives Setup, Lock, Security and Accounts through AT-SPI. Parity: Lock 0.49 % (PASS); Overview unchanged
  (2.6 % pixels). No Electron stills exist for Setup, Security or Accounts.
- Not done / stubbed: the OS seal (the app passes `Unsupported`, so `account.json` is written with `seal: 'none'`, passwordless is refused, and `seal: 'os'` files from Electron
  cannot be opened until `kb-oseal` is wired and `kb-session` reads `os-native`); default categories are not localised after setup; Setup import; clipboard copy of the recovery
  key; "recovered, choose a new password" screen (Security works without the current password after a recovery unlock); window input does not count as activity (only service calls
  and navigation), so the idle timer needs the OS idle time on Windows and macOS; the migration progress above.
- Needs Windows or macOS: Hello / Touch ID inside `auth.unlock`, OS idle and lock/suspend events, the real seal.
- Review follow-ups done in `kb-service` and the app: OS-random `Rng` for the real core; `--fake-device` / `--demo-setup` only with the cargo feature `dev-start`
  (CI build and `startup-test-core.sh`; the demo password is moved into a `Zeroizing` holder, not kept in `Config`); no temp-folder fallback for the data folder, folder 0700,
  prefs temp files `create_new` 0600; one prefs writer (`kb_service::update_prefs_key`: corrupt file moved to `prefs.json.bad`, writes only on change); erase/restore close the
  core's database handle first; wrong tries kept in `lastAuth.attempts` for the pre-unseal throttle.
- TODO (needs `kb-session`, not done): real `OsEvents` per OS (lock on screen lock/suspend, OS idle time, plus a boot-time/monotonic backstop in the idle tick instead of `Instant`
  alone); `OpHandler` taking `&Value` so secrets in the `serde_json::Value` of an op can be wiped after the call.
- Done since: the OS seal is wired: `CoreOptions::native` = `select_os_seal_for` + `plan_migration`/`apply` in the worker before the session reads account.json; the
  Electron folder is the default again when the seal is available; tests `kb-service/tests/os_seal.rs` with fake seals, no real keyring.

New texts for the release branch's locale files (the app keeps them in `crates/kb-i18n/locales/extra.<lang>.json`; add them to the 8 files of
`src/renderer/src/i18n/locales` if the Electron app should share them): `loading.opening`, `loading.migrating`, `loading.transactions`,
`loading.overview`, `loading.unlocking`, `native.notPortedTitle`, `native.notPortedBody`, `native.opNotPorted`, `native.holdToShowNumbers`,
`native.assistantNote` (translations in the extra files are mine and need a native check).

**Polish list (accepted, adjust later; owner decision, see section 0)**

- Password: Slint's fixed `●` mask glyph instead of the React mask (pixels).
- Select: native dropdown arrow vs our chevron (pixels).
- Date field: landmark offsets of 6 px (landmarks).
- Page header: landmark offset of 5 px as measured in the spike (landmarks), plus pixel diff over 3% (pixels). The owner's note said 2–4 px; re-measure to confirm.
- MonthNav and Toast: landmark offsets of 8 px and 6 px; cause not yet explained (landmarks).
- Badge: 3.07% pixel diff (pixels).
- Gaps: see `rust/crates/kb-ui/README.md` (Slint limits). Windows and macOS were not run: UIA/Narrator/VoiceOver, real focus ring and IME in the fields, popup placement at window edges, fonts under DirectWrite/CoreText.

**kb-oseal (OS seal, G6 second half; built and unit-tested on Linux, cross-checked for Windows and macOS only)**
- `rust/crates/kb-oseal`: `OsSeal` implementations behind cfg: Windows DPAPI (`windows` crate, user scope, fixed entropy, blob `KBD1 || DPAPI`),
  macOS Keychain wrap key (`security-framework`, item `Kasboek Wrap Key`, AES-256-GCM, blob `KBK1 || iv || ct || tag`), Linux Secret Service
  (`oo7` 0.7, MIT, async-io runtime, no tokio, wrapped with `futures-lite::block_on`; item `service=Kasboek, account=wrap-key`), fallback `Unsupported`.
  `legacy`: Electron key material per OS, `open_electron_account_json(data_dir)`, `plan_migration` / `MigrationPlan::apply` (re-seal as
  `seal:'os-native'`, original kept as `account.electron.json`).
- Needs the real OS (not confirmed): DPAPI calls and entropy on a real profile, Keychain access-control prompts and locked-keychain codes,
  `oo7` against GNOME Keyring / KeePassXC (and collection unlock prompts), the exact attributes Electron 45 gives its Linux item
  (`application=Kasboek`, label `Kasboek Safe Storage` assumed), KWallet (not supported), and that Electron's async values keep the OSCrypt layouts.
- Seal values (done in kb-session): `none` plain, `os` Electron `safeStorage` (and the test `FileSeal`), `os-native` written by the native seals (`OsSeal::seal_value`). The store opens `os` and `os-native` through the configured seal; `plan_migration` treats a native `os` file (`KBD1`/`KBK1`) as migrated. The app calls `kb_oseal::select_os_seal_for(data_dir)` for `Config::new`, then `plan_migration` + `apply` at start.
- `account.electron.json` is deleted after the first native unlock that saved, and on every credential change; erase/restore carry it.
- Wrap key: created only when absent (Keychain `SecItemAdd`; Secret Service oldest-item-wins), deleted and recreated when the data folder has no native account (nor an erased one) yet; `usable()` neither prompts nor remembers a "no". macOS and Linux keyring behaviour is untested on real machines.

## Appendix: not verified offline (each is a spike or M1 task)

- Slint: Skia prebuilt binaries for aarch64-pc-windows-msvc (Skia did not run in the spike), tooltip and popover
  behaviour at window edges, Windows 11 Snap Layouts with a custom title bar. Variable fonts and OpenType features
  are settled by spike B (section 10).
- Electron 45 async safeStorage format on each OS, and the macOS Keychain item names.
- Whether sqlite3mc's chacha20 `hexkey` path runs its PBKDF2 (affects DB open time). The spike's open time does not
  settle it.
- Argon2id speed on ARM and Windows (Linux x64 measured, section 10).
- Text segmentation on real bank PDFs (spike C used invented files; the owner's real-file check is pending).
- WinRT `RequestVerificationForWindowAsync` latency to a visible prompt on Windows ARM64.

Sources checked (Nov 2026): slint.dev blog 1.16 and 1.17; iced 0.14 release notes and FAQ; DioxusLabs/blitz
README; docs.rs gpui-pre; docs.rs libsqlite3-sys.
