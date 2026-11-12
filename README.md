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
- **Security**: password or passwordless (Windows Hello / Touch ID), optional two-factor codes,
  recovery key, auto-lock. Encrypted database; the data folder can't be opened on another
  computer. Moving computers only works through an encrypted **export** that opens with your login.
- **Backups**: automatic, encrypted, daily, to a folder you choose.

## Run it

Requirements: Node.js 22.12 or newer.

```bash
npm install        # also builds the encrypted-SQLite module for Electron
npm run dev        # start the app with hot reload
```

If `npm install` on Windows fails while building `better-sqlite3-multiple-ciphers`, install the
“Desktop development with C++” workload from Visual Studio Build Tools and run it again.

## Build an installer

Build each platform on that platform, or use the GitHub Actions workflow
(`.github/workflows/build.yml`: push a tag like `v0.9.0`, or run it from the Actions tab).

```bash
npm run dist:win     # release/<version>/Kasboek-Setup-<version>-x64.exe (and arm64)
npm run dist:mac     # .dmg (unsigned until a signing certificate is set up)
npm run dist:linux   # AppImage and .deb
```

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
