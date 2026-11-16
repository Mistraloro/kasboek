# Kasboek

A simple, local-first budget app for Windows, macOS and Linux, with an AI assistant built in
(Claude, or any OpenAI-compatible provider, including local models). Your data stays on your computer, encrypted, and is locked to your computer and login.

See [PLAN.md](PLAN.md) for the design, the security model and what still needs testing.

## What it does

- **Budget**: accounts, transactions (search, filter, edit, bulk categorise or rename, saved
  searches, split one payment over categories), categories, rules ("Supermarket → Groceries", on text,
  whole words or the counterparty's IBAN), monthly budgets, and an overview with income, spending,
  budget left, warnings and a 6-month chart; a year view per category; net worth over time with
  investments and loans; savings goals; fixed costs and subscriptions found from your transactions.
  Refunds lower spending; transfers between your own accounts are paired and left out.
  Dark and light mode, eight languages, number and date formats chosen part by part.
- **First start**: a welcome window sets the language, number and date style, exchange rates, the
  assistant, Claude Desktop / Claude Code and update checks, then offers a short tour of the app.
- **Bank balance**: enter what your bank shows (or let a CSV balance column do it); the balance is
  counted from there, and a later balance that doesn't match shows the difference.
- **Currencies**: each account in its own currency; totals in a main currency at the rate of each
  transaction's date (ECB reference rates, on by default in the welcome window, or your own rates).
  A transfer between your accounts in different currencies is paired at that day's rate; what the
  bank kept on the conversion counts as a fee. Give an account its usual "Exchange cost (%)", or
  change the cost per transfer to the amount on your statement.
- **CSV import**: drop a bank export. Kasboek reads the CSV exports of most large banks and payment
  apps in Europe, the UK, the Americas and beyond, with headers in many languages: dates with the
  day or month first or with month names, decimal commas or points, currency signs, separate
  debit and credit columns or a debit/credit column. Anything it can't place you choose yourself,
  and "Remember this format" keeps your choice for the next file. It flags duplicates (also by
  bank reference, and "maybe imported" when the bank changed the text), applies your rules and the
  names you tidied before, and shows everything before saving. Undo per import. Export to CSV, and
  a year report as PDF.
- **Assistant**: ask questions about your money or let the assistant make changes. You choose which
  kinds of change it may make by itself and which wait for your OK (Settings → Assistant → "What
  the assistant may do by itself"), how much it reasons per model, and what it remembers between conversations
  (kept encrypted on this computer only). "Check with …" categorises a CSV, makes names readable, suggests rules and
  sorts older uncategorised transactions, showing its reasoning in the assistant panel; a monthly
  review on the Overview. Claude, Mistral, Groq,
  DeepSeek, Gemini, OpenRouter, Together, Fireworks, Ollama, LM Studio or any OpenAI-compatible server.
- **MCP**: use Kasboek from Claude Desktop or Claude Code, added with one click (welcome window or
  Settings → Assistant). Settings shows whether each app is connected now or when it last used
  Kasboek; a tray icon shows the connection and can stop it.
- **Sync**: keep several computers in step through a cloud folder you already use; only encrypted
  files go there, and changes merge per field.
- **Same everywhere**: Windows, macOS and Linux use the same encrypted database and the same export
  format, so an export from one opens on any other (with your login).
- **Security**: password (Argon2id) or passwordless (Windows Hello / Touch ID), optional two-factor codes,
  recovery key, auto-lock. Encrypted database; the data folder can't be opened on another
  computer. Moving computers only works through an encrypted **export** that opens with your login.
- **Backups**: automatic and encrypted, after important changes and daily, kept by age (24 hours,
  30 days, a year), to a folder you choose.
- **Updates**: a button at the top when a new release is out; Kasboek downloads, checks and
  installs it. The version you run is shown at the bottom of the menu.

## Run it

**Using Kasboek needs nothing else:** the installers (MSI, DMG, AppImage, .deb) contain everything,
including the runtime Kasboek runs on (Electron, with its own built-in Node.js). Node.js is only
needed to work on Kasboek's source code.

For development: Node.js 22.12 or newer. Nothing is compiled: the encrypted database engine ships
prebuilt 64-bit binaries for Windows, macOS and Linux (x64 and ARM64).

```bash
npm install
npm run dev        # start the app with hot reload
```

## Installers (64-bit only)

| OS | Files | Architectures |
|---|---|---|
| Windows | `.msi` installer | x64, ARM64 |
| macOS | `.dmg`, one per chip | Apple Silicon (arm64), Intel (x64) |
| Linux | `.AppImage` and `.deb` | x64, ARM64 |

**Download**: the repository's **Releases** page has every installer for each version.

**Updates from the app**: Kasboek asks GitHub for the latest release at start and once a day
(switch in the welcome window and in Settings; GitHub sees the IP address, nothing else is sent).
A newer release shows an "Update to …" button at the top. The download is checked against the
SHA-256 GitHub reports for the file (or the release's `SHA256SUMS.txt`), the data is backed up to
`safety-backups`, then: Windows runs the MSI silently and reopens Kasboek; an AppImage replaces
itself; a `.deb` or `.dmg` is opened for you to finish. Only published releases count: test builds
on the Actions page are not offered.

**Publish a new version**: raise the version (`npm version patch --no-git-tag-version`, or `minor`
for new features), update `.github/release-notes.md`, commit and push. Then run the **Build
installers** workflow with “Publish as a release” ticked (or push a matching tag, `v0.13.1`). It
builds every OS on a real machine of that OS and attaches the files, with `SHA256SUMS.txt`, to a
new Release. Without “Publish as a release” it makes a test build whose files stay under the run's
Artifacts for 90 days.

Locally, each OS builds its own installers: `npm run dist:win`, `npm run dist:mac`,
`npm run dist:linux`. (The Linux packages can also be built on other systems; the `.msi` needs
Windows.)

**A white or empty window?** Some graphics drivers (notably on Windows on ARM / Snapdragon) can't
show Kasboek's window. Kasboek then draws without the graphics card: by default on Windows on ARM,
and on any computer after the graphics card failed to show it at a start (Kasboek restarts once by
itself). Settings → General → Graphics card changes it; `startup.log` in the data folder says what happened.

**Uninstalling** removes the program, its shortcuts, registry entries, caches and Kasboek's
entries in Claude Desktop and Claude Code. Your data stays, so a reinstall picks up where you left
off. To delete it too, run the same installer again, choose Remove and tick “Also delete my Kasboek data”. Sync and backup folders are never touched.

**Signing.** Without certificates, Windows SmartScreen shows “Windows protected your PC” on first
install (More info → Run anyway), and macOS shows “cannot verify the developer” (right-click the
app → Open, once). The Mac app is ad-hoc signed so it runs on Apple Silicon. To sign properly,
add `CSC_LINK` / `CSC_KEY_PASSWORD` repository secrets (Apple Developer ID, or a Windows
code-signing certificate).

## Assistant

1. In the welcome window or Settings → Assistant, choose a provider. For Claude, create an API key at
   console.anthropic.com (billed by Anthropic, separately from Claude.ai); other providers have
   their own key page, linked there. Ollama and LM Studio run on your computer and need no key.
2. Add the key. It is stored inside your encrypted data, separately per provider.
3. Claude defaults: chat with Claude Sonnet 5.5 (medium effort), CSV checks with Claude Opus 5.5
   (medium). Other providers: type a model name or load the list from the provider.

Messages, the data the assistant looks up and what it remembers go to the chosen provider (or
stay on your computer for local models). Nothing is sent until you ask.

**Permissions**: "Always ask" (the default), "Ask for important changes", "Decide by itself" or a
choice per kind of change. Balances, deleting rules, new accounts, imports and remembering things
ask unless you allow them; changes to more than 100 transactions always ask, except in "Decide by
itself". Changes made without asking show in the chat.

**Memory**: say "remember that …", or add items in Settings → Assistant → "What the assistant remembers". Up to
50 short items, stored in the encrypted database, not synced and not offered to Claude apps over
MCP. Account and card numbers are refused. Switch it off to stop sending it.

**Claude Desktop / Claude Code (MCP)**: switch on “Claude Desktop & Claude Code (MCP)” in
Settings → Assistant and press “Add to Claude Desktop” or “Add to Claude Code”. It works while
Kasboek is running and unlocked; changes wait for your approval in Kasboek.

## Sync

Settings → Backups & sync → Sync between computers → Choose folder (a folder your cloud app syncs). On the other
computer: Join a sync folder, then your password and 2FA code (or recovery key). Kasboek writes
encrypted change files there; the key never leaves your encrypted data except inside an
encrypted snapshot. Passwordless sign-in is set up per computer.

## Checks

```bash
npm run typecheck
npm test            # runs under Electron's Node, so the native module matches
npm run check:i18n  # every text key exists in en.json, and every translation matches it
npm run test:mcp    # the Go MCP helper
```

## Where your data lives

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Kasboek` |
| macOS | `~/Library/Application Support/Kasboek` |
| Linux | `~/.config/Kasboek` |

- `kasboek.db`: encrypted database
- `account.json`: login key slots, sealed by the operating system (only opens on this computer and account)
- `prefs.json`: theme, language, formats, auto-lock (nothing sensitive)
- `sync.json`: this computer's sync id and folder, when syncing
- `safety-backups/`: copies made automatically before an import and before an update
- `updates/`: a downloaded update while it installs
- `startup.log`: what happened during the last start (version, system, graphics card, steps), never
  your data; useful when Kasboek doesn't open properly

The assistant's memory, settings that sync and everything you enter live inside `kasboek.db`.

Copying this folder to another computer does **not** work, by design. Use Settings → Backups & sync
→ Move to another computer → Export, then Import on the new computer with your password and 2FA code (or
your recovery key).

## Project layout

```
src/shared/       operation contract, types, amount/month helpers (used everywhere)
src/core/         database, migrations, account & crypto, export format, finance, CSV import,
                  assistant tool loop (no Electron; unit-tested)
src/main/         Electron main: window & security, IPC, session/lock, OS keychain,
                  Windows Hello / Touch ID, backups, sync, AI providers, MCP bridge
tools/kasboek-mcp/  the small Go helper Claude apps start for MCP
src/preload/      the small bridge exposed to the page
src/renderer/     React UI, theme tokens, i18n strings (src/renderer/src/i18n/locales)
assets/brand/     logo and icon sources;  npm run icons  regenerates build/ icons
tests/            unit tests, CSV fixtures and bank samples (tests/banks.test.ts)
```

## Adding a language

Copy `src/renderer/src/i18n/locales/en.json` to e.g. `it.json`, translate the values, add it to
`LANGUAGES` in `src/shared/languages.ts` and to the resources in `src/renderer/src/i18n/index.ts`.
A regional variant can hold only the texts that differ (see `scripts/regional-locales.py`).
`npm run check:i18n` lists missing keys and placeholder mistakes.
