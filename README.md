# Kasboek

A simple, local-first budget app for Windows (macOS and Linux from the same code), with Claude
built in. Your data stays on your computer, encrypted, and is locked to your computer and login.

See [PLAN.md](PLAN.md) for the design, the security model and what still needs testing.

## What it does

- **Budget**: accounts, transactions (search, filter, edit, bulk categorise), categories, rules
  ("Delhaize → Groceries"), monthly budgets, and an overview with income, spending, budget left
  and a 6-month chart. Dark and light mode.
- **CSV import**: drop a bank export. Kasboek recognises Argenta, Hello bank! and Keytrade Bank
  (and most other layouts), flags duplicates and unreadable rows, applies your rules, and shows
  everything before saving. Undo per import.
- **Claude**: ask questions about your money or let Claude make changes, which you approve one by
  one. "Check with Claude" fixes messy CSV files before import.
- **MCP**: use Kasboek from Claude Desktop or Claude Code (Settings → Claude).
- **Same everywhere**: Windows, macOS and Linux use the same encrypted database and the same export
  format, so an export from one opens on any other (with your login).
- **Security**: password (Argon2id) or passwordless (Windows Hello / Touch ID), optional two-factor codes,
  recovery key, auto-lock. Encrypted database; the data folder can't be opened on another
  computer. Moving computers only works through an encrypted **export** that opens with your login.
- **Backups**: automatic, encrypted, daily, to a folder you choose.

## Run it

Requirements: Node.js 22.12 or newer. Nothing is compiled: the encrypted database engine ships
prebuilt 64-bit binaries for Windows, macOS and Linux (x64 and ARM64).

```bash
npm install
npm run dev        # start the app with hot reload
```

## Installers (64-bit only)

| OS | Files | Architectures |
|---|---|---|
| Windows | `.msi` and `.exe` installer | x64, ARM64 |
| macOS | `.dmg` (one universal app) | Intel + Apple Silicon |
| Linux | `.AppImage` and `.deb` | x64, ARM64 |

**Download**: the repository's **Releases** page has every installer for each version.

**Publish a new version**: set `version` in `package.json`, commit, then push a matching tag
(`git tag v0.9.1 && git push origin v0.9.1`). The **Build installers** workflow builds every OS on a
real machine of that OS and attaches the files to a new Release. Running the workflow by hand
instead makes a test build whose files stay under the run's Artifacts for 90 days.

Locally, each OS builds its own installers: `npm run dist:win`, `npm run dist:mac`,
`npm run dist:linux`. (The Windows `.exe` and the Linux packages can also be built on Linux, with
Wine for the `.exe`.)

**Signing.** Without certificates, Windows SmartScreen shows “Windows protected your PC” on first
install (More info → Run anyway), and macOS shows “cannot verify the developer” (right-click the
app → Open, once). The Mac app is ad-hoc signed so it runs on Apple Silicon. To sign properly,
add `CSC_LINK` / `CSC_KEY_PASSWORD` repository secrets (Apple Developer ID, or a Windows
code-signing certificate).

## Claude

1. Create an API key at console.anthropic.com (billed by Anthropic, separately from Claude.ai).
2. In Kasboek: Settings → Claude → Add API key. The key is stored inside your encrypted data.
3. Defaults: chat with Claude Sonnet 5.5 (medium effort), CSV checks with Claude Opus 5.5
   (medium). Both can be changed in Settings.

Messages and the data Claude looks up are sent to Anthropic. Nothing is sent until you ask.

**Claude Desktop / Claude Code (MCP)**: switch on “Claude Desktop & Claude Code (MCP)” in
Settings → Claude and copy the snippet shown there. It works while Kasboek is running and
unlocked; changes wait for your approval in Kasboek.

## Checks

```bash
npm run typecheck
npm test            # runs under Electron's Node, so the native module matches
npm run check:i18n  # every text key used in the UI exists in en.json
```

## Where your data lives

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Kasboek` |
| macOS | `~/Library/Application Support/Kasboek` |
| Linux | `~/.config/Kasboek` |

- `kasboek.db`: encrypted database
- `account.json`: login key slots, sealed by the operating system (only opens on this computer and account)
- `prefs.json`: theme, language, auto-lock (nothing sensitive)
- `safety-backups/`: copies made automatically before an import

Copying this folder to another computer does **not** work, by design. Use Settings → Move to
another computer → Export, then Import on the new computer with your password and 2FA code (or
your recovery key).

## Project layout

```
src/shared/       operation contract, types, amount/month helpers (used everywhere)
src/core/         database, migrations, account & crypto, export format, finance, CSV import,
                  assistant tool loop (no Electron; unit-tested)
src/main/         Electron main: window & security, IPC, session/lock, OS keychain,
                  Windows Hello / Touch ID, backups, Claude, MCP bridge and --mcp helper
src/preload/      the small bridge exposed to the page
src/renderer/     React UI, theme tokens, i18n strings (src/renderer/src/i18n/locales)
assets/brand/     logo and icon sources;  npm run icons  regenerates build/ icons
tests/            unit tests and CSV fixtures
```

## Adding a language

Copy `src/renderer/src/i18n/locales/en.json` to e.g. `nl.json`, translate the values, and add it
to `LANGUAGES` in `src/renderer/src/i18n/index.ts`. `npm run check:i18n` lists missing keys.
