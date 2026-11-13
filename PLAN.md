# Kasboek — plan

A simple, clean, local-first budget app for the desktop, which Claude (and later any LLM) can operate.

## Decisions

| Topic | Decision |
|---|---|
| Platform | Desktop app for Windows, macOS and Linux, **64-bit only** (x64 and ARM64); same database and export format everywhere |
| Stack | Electron + React + TypeScript (electron-vite), Tailwind CSS |
| Storage | Local only. One SQLite file, **encrypted** (SQLite3 Multiple Ciphers, ChaCha20-Poly1305), native prebuilt engine on every OS |
| Language | English UI; every string goes through i18next so more languages are a JSON file away |
| Banks | Argenta, Hello bank!, Keytrade Bank (plus a generic “other”) |
| Money | Integer cents, EUR by default, Belgian number/date formats |
| Look | Dark and light mode with a green accent; Inter (UI) + Source Serif 4 (headings), bundled locally |

Anthropic’s own typefaces are licensed, so the closest free equivalents are used: Inter for text
(it has tabular numbers, so amounts line up) and Source Serif 4 for page titles.

## Architecture

```
┌─────────────── Renderer (React UI) ───────────────┐
│  sandboxed, no Node access, strict CSP            │
└──────────────┬────────────────────────────────────┘
               │ window.kasboek.invoke(op, input)   (one IPC channel)
┌──────────────▼──────────── Main process ──────────┐
│  Operation registry  ← Zod-validated, audit-logged │
│    core ops (accounts, categories, budgets, …)     │──► later: Claude tools (Phase 4), MCP (Phase 5)
│    desktop ops (file dialogs, backups, keychain)   │
│  Encrypted SQLite · OS keychain · backup service   │
└────────────────────────────────────────────────────┘
```

* `src/shared/contract.ts` lists every operation with its input schema. The UI, the in-app Claude
  chat and the MCP server all go through the same list, so an AI can never do something the
  UI couldn’t, and every change is validated and written to `audit_log` with who did it
  (`user`, `assistant` or `system`).
* Operations are marked `assistant: true/false`. Desktop-only actions (file dialogs, restore,
  passwords) are never offered to an AI.

## Login, device binding and moving computers

**Signing in** (chosen at first start, changeable later)
* **Password**: the master key is unlocked with your password, hashed with **Argon2id** (128 MiB, 3 passes, 4 lanes; RFC 9106). Older scrypt slots still open and are upgraded on the next unlock.
* **Passwordless**: unlock with **Windows Hello** (face, fingerprint or PIN) or **Touch ID**.
  The master key is protected by the operating system account; Hello/Touch ID confirms it’s you.
  Password mode is stronger: passwordless doesn’t protect against malware running as you.
* **Two-factor authentication (optional, both modes)**: 6-digit codes from an authenticator app
  (Microsoft Authenticator, Google Authenticator, 1Password, …), TOTP / RFC 6238. Set up with a QR code.
* **Recovery key**: shown once at setup (write it down or print it). Unlocks if you forget the
  password or lose your phone, and is how passwordless accounts move to another computer.
* Wrong attempts slow down (increasing waits). **Auto-lock** after inactivity, when the screen
  locks or the computer sleeps. Lock now at any time.

**Key hierarchy**
```
password ─Argon2id─►┐
recovery key ─────┼─► master key M ─► vault { database key, 2FA secret }
Windows Hello ────┘        (each is a "key slot" that unwraps M)
everything above, on disk ─► sealed again by the OS (DPAPI / Keychain / keyring) = device binding
```

**Device binding: copying the data folder doesn’t work.** The account file is sealed by this
computer’s operating-system account. A copy on another computer (or another Windows user) can’t
be opened, not even with the right password. Without the password (or Hello), it can’t be
opened on this computer either.

**Moving computers / backups: the only way out**
* **Export** (Settings → Move to another computer) writes one `.kasboek` file. It contains the
  encrypted database and vault, sealed with AES-256-GCM under the master key, plus the password
  and recovery key slots, but **no device layer**.
* It only opens through **Import** in Kasboek on the new computer, with your **password and
  2FA code** (or the recovery key). There’s no other way to read it.
* **Automatic backups** use the same format and protection, so a dead laptop isn’t lost data.
  They’re made while Kasboek is unlocked, without asking for your password.
* Changing your password doesn’t change older exports: they keep opening with the password
  that was current when they were made.
* 2FA is checked by the app. The encryption itself rests on the password/recovery key and
  (locally) the device. This is the honest limit of offline 2FA.

**Hardening** (from Phase 1): context isolation, sandboxed renderer, strict CSP, no navigation or
pop-ups, all permission requests denied, one IPC channel that only accepts the app’s own page,
Electron fuses in packaged builds. While locked, the database is closed and only login
operations are accepted.

## CSV import (Phase 4–5)

1. **Parse in code**: detect encoding (UTF-8 BOM / Windows-1252), delimiter (`;` is typical in
   Belgium), header row (some exports have lines above it), decimal commas, `dd/mm/yyyy` dates.
2. **Known bank?** Match the header row against saved profiles (Argenta, Hello bank!, Keytrade).
   A match means no AI is needed.
3. **Claude checks** unknown or messy files. It sees the header and sample rows and returns a
   strict JSON **mapping plan** plus specific row fixes and category suggestions. Claude does not
   retype amounts: code applies the plan, so numbers can’t be invented and token costs stay low.
4. **Validate in code**: dates valid, amounts parse, running totals match where the bank gives a
   balance, duplicates against existing transactions (fingerprint of date + amount + counterparty + reference).
5. **Preview**: you see fixes, suspected duplicates and uncategorised rows, and approve. Only then
   is anything written.
6. The mapping is saved as a profile, so the next file from that bank imports instantly.

Belgian specifics handled: structured communication (`+++123/4567/89012+++`), BE IBANs,
own-account transfers (matched by IBAN, categorised as transfers, not spending).

**What I need from you for Phase 3:** one real CSV export from each bank. You can blank out
names and amounts; the column layout is what matters.

## Claude (Phase 5) and MCP (Phase 6)

* **In-app chat** (side panel): Claude uses the operation registry as tools. Questions are answered
  from your data; anything that changes data shows an Approve / Decline card first. Input is
  validated before you are asked. The conversation lives in memory and is cleared on lock.
* **Check with Claude** on the import screen: Claude returns a strict JSON plan (columns, row fixes,
  categories, notes). Code applies it through the same checks as a manual edit; a mapping that
  reads fewer rows than the detected one is rejected.
* **API key**: stored inside the encrypted database (so it is protected by your login and moves
  with an export), never sent to the page; requests go from the main process only.
* **Refusal fallbacks**: Opus 5.5, Sonnet 5.5 and Fable 5.2 requests use server-side fallbacks, so a
  safety-classifier decline is retried on a suitable model in the same call.
* **MCP server**: `Kasboek --mcp` is a stdio MCP server for Claude Desktop, Claude Code or any MCP
  client. It holds no keys and opens no database: it forwards calls over a named pipe / Unix socket
  (per-start token) to the running app, which must be unlocked with MCP switched on. Changes wait
  for approval in the app.
* **Other LLMs later**: everything goes through the operation contract, whose input schemas are
  plain JSON Schema for tools. MCP already works with any MCP-capable client; an in-app adapter
  for another provider would replace `src/main/assistant/claude.ts`.

## Models and effort

**Building the app (Claude Code)**
* Phases 1–4 (data model, security, CSV pipeline, AI integration): **Claude Opus 5.5, effort high**.
* UI polish and small changes: Opus 5.5, effort medium.
* Fable 5.2 is stronger but about twice the price; not needed for a project this size.

**Inside the app** (switchable in Settings)

| Task | Model | Effort |
|---|---|---|
| CSV check and mapping plan | Claude Opus 5.5 | medium |
| Chat questions and commands | Claude Sonnet 5.5 | low–medium |
| Bulk categorisation (optional) | Claude Haiku 5.5 | low |

You’ll need an Anthropic API key (console.anthropic.com). It’s billed separately from a Claude.ai subscription.

## Phases

| # | Scope | Status |
|---|---|---|
| 1 | Project setup, theme, layout, encrypted DB, OS keychain, encrypted backups, i18n, accounts, app icons, packaging | Done |
| 2 | **Login & device security**: password or passwordless (Windows Hello / Touch ID), 2FA (TOTP), recovery key, lock screen, auto-lock, device binding, encrypted **export/import for moving computers**, backups moved onto login credentials | Done |
| 3 | Transactions (list, search, edit, bulk categorise), categories, rules, monthly budgets, overview with real numbers and charts | Done |
| 4 | CSV pipeline in code: encoding/delimiter/header detection, Argenta / Hello bank! / Keytrade profiles, preview, duplicates, import, undo import | Done |
| 5 | Claude: API key and model settings, chat panel with tools and confirmations, CSV assistant | Done |
| 6 | MCP server for Claude Desktop / Claude Code | Done |
| 7 | Tests with bank fixtures, polish, docs, release builds for all three OSes | Done (needs a real Windows run, see below) |

## Brand

`assets/brand/` holds the source SVGs: `icon.svg` (app icon), `icon-small.svg` (16–32 px),
`icon-light.svg`, `mark.svg` (bare mark, follows the text colour). `npm run icons` regenerates
`build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icons/*.png` (Linux) and the
window icon. The mark is a **K** whose bright upper arm stands for money in and dimmed lower
arm for money out.

## Status and what still needs a real computer

Built and tested here (Linux, automated): 31 unit tests (crypto, TOTP test vectors, key slots,
export format and tampering, budgets and summaries, CSV parsing for the three bank layouts,
import duplicates/undo, the assistant loop) and end-to-end runs of the real app for setup,
lock/unlock, 2FA, recovery, export → import on a "new computer", passwordless (simulated),
transactions, budgets, CSV import, Claude chat and CSV check (against a local mock of the API)
and MCP with a real MCP client.

Not possible to test here, please check on your machine:
1. **Windows Hello** prompt (via PowerShell / WinRT) and **Touch ID**: simulated in tests only.
2. **DPAPI device binding**: copy `%APPDATA%\Kasboek` to another PC or Windows user and confirm it
   refuses to open (the error path is tested; the real DPAPI behaviour can only be seen on Windows).
3. **Real Claude calls** with your API key (tested against a mock with the same request format).
4. **Your real bank exports**: the fixtures imitate the layouts; send one anonymised export per
   bank to confirm (the column editor and "Check with Claude" cover differences).
5. **Installers**: `.exe` (Windows x64) and the Linux AppImage/.deb (x64, ARM64) were built here;
   the `.msi` and the universal `.dmg` are built by the GitHub Actions workflow on real Windows and
   macOS machines. Unsigned until certificates are added (see README → Installers).

## Next release (backlog)

Installer feedback from testing the 0.9.0 `.msi` on Windows:

1. **Installer: choose shortcuts, and update an existing install.** Installing a new version over an
   older one must upgrade it in place (same install folder, data untouched, no duplicate entry in
   Apps & Features), for both the `.msi` (fixed UpgradeCode, MajorUpgrade) and the `.exe`.
   **Let people choose the shortcuts.** The installer creates the desktop and Start menu shortcuts
   without asking. Add two ticked-by-default checkboxes ("Desktop shortcut", "Start menu
   shortcut") on a page before installing. For the `.msi` this needs a custom WiX dialog
   (electron-builder's built-in MSI UI has no such options; `msiProjectCreated` can edit the
   generated WiX project). The NSIS `.exe` can do it with a small `include` script.
2. **Kasboek branding in the `.msi` wizard.** The setup dialogs still show WiX's default red disk
   (banner top right, large image on the welcome/finish pages). Provide our own images in
   `build/` (WiX sizes: banner 493×58, dialog 493×312, as .bmp/.png) generated from
   `assets/brand/`, and wire them in as `WixUIBannerBmp` / `WixUIDialogBmp`. Check the `.exe`
   installer's sidebar image at the same time.
3. **Launch window (splash screen).** After starting Kasboek nothing appears for a moment, so it
   isn't clear the app is opening. Show a small window immediately (logo, "Kasboek", light/dark
   theme) with a **loading animation and a progress bar** that moves through the real start-up
   steps (starting, opening your data, loading the interface), so it's visibly working. Close it
   when the main window is ready. Also look at what makes start-up slow (opening the encrypted account, the Windows
   Hello availability check, loading the UI bundle) and trim it.
4. **Account names instead of bank presets.** No fixed list of bank names: people name each
   account and its bank themselves (free text, e.g. "KBC zichtrekening"). The CSV import keeps
   recognising file layouts from their column names (Dutch, French, English, German), whichever
   bank they come from, and remembers each layout after the first import.
5. **Backups at the right moments, with tiers.** Today: one full backup a day, keeping the last N.
   Add a backup right after important changes (CSV import, restore, bulk edits) and when closing
   Kasboek, and keep them in tiers: every change for the last 24 hours, one per day for 30 days,
   one per month for 12 months. Every copy stays a complete, independent encrypted export (no
   chains of incremental pieces, which break if one piece is lost); the database is small enough
   that full copies are fast. Show the backup list with dates in Settings, with restore.
6. **Stronger password rules.** Minimum 16 characters, at least three of: lowercase, uppercase,
   digits, symbols; refused if it is on a built-in list of common/breached passwords, contains
   "kasboek", or is mostly one repeated character/sequence; a live strength meter (zxcvbn-style)
   that must reach "strong". Long passphrases (several random words) pass easily and are
   encouraged. Applies to new passwords and password changes; existing users are asked to choose
   a stronger one at their next unlock. Matters even more once sync puts encrypted data in the
   cloud, where it could be attacked offline.
7. **2FA: "Remember this computer for 30 days".** Optional tick box when entering the 2FA code.
   This computer then only asks for the password (or Windows Hello / Touch ID) for 30 days; other
   computers, imports and exports still ask for the code. The "remembered" mark is sealed by the
   OS (so it can't be copied to another computer), is cleared by changing the password, turning
   2FA off/on, or "Forget remembered computers" in Settings, and never applies to the recovery
   key flow.
8. **Sync between computers (Windows, macOS, Linux).** Through a cloud folder the person
   chooses (Google Drive, OneDrive, Dropbox, iCloud Drive), no Kasboek server.
   - Each computer writes its changes as small encrypted change files (not the whole database);
     the others merge them. Conflicts are resolved per field, latest change wins, nothing is
     silently dropped (a conflict note is shown where two edits clashed).
   - The cloud only ever holds encrypted data (same protection as an export). Joining a new
     computer: choose the sync folder, then the password + 2FA code (or the recovery key). After
     that it unlocks locally as usual; passwordless is set up per computer.
   - Backups (item 5) stay separate and keep working per computer.
   - Risk to state in the UI: encrypted data lives permanently in the cloud, so a long password
     (item 6) is what protects it if the cloud account is compromised. Optional extra: a separate
     sync key that is never stored in the cloud.
9. **One-click MCP setup for Claude Desktop and Claude Code** (Settings → Claude).
   - *Add to Claude Desktop*: finds `claude_desktop_config.json` (Windows `%APPDATA%\Claude\`,
     macOS `~/Library/Application Support/Claude/`), shows the exact entry it will add, then adds
     or updates only `mcpServers.kasboek` and keeps everything else. Backs up the file first,
     writes atomically, and stops with an explanation (never overwrites) if the file isn't valid
     JSON. Says to restart Claude Desktop. A *Remove* button undoes it. Linux: no official Claude
     Desktop, keep the snippet. Also evaluate Claude Desktop's one-click extension format.
   - *Add to Claude Code*: if `claude` is on the PATH, runs `claude mcp add --scope user kasboek
     -- <Kasboek> --mcp` after confirmation and shows the result; otherwise keeps the copyable
     command. A *Remove* button runs `claude mcp remove kasboek`.
   - Only ever on a button press, with the change shown first.
10. **MCP on Windows (bug in 0.9.0).** Claude Desktop starts `Kasboek.exe --mcp`, which exits
    after about a second: Electron's windowed app on Windows has no usable stdin, so the stdio MCP
    connection closes. Fix: ship a small console helper `kasboek-mcp` (Go, ~5 MB, no runtime) next
    to Kasboek on every OS. It speaks MCP over stdio and forwards to the running, unlocked app over
    the existing local channel; it holds no keys and opens no database. Config points to it.
11. **Import an Excel budget workbook** (like a friend's yearly sheet with one tab per year:
    expense categories × months, transfers to savings/investments, income types, investments paid
    in and portfolio value per broker, opening balances). Read the .xlsx locally, show a preview of
    what lands where (categories, monthly totals as one transaction per category per month,
    opening balances), let the person map unknown labels, and import nothing until approved.
    Investment and net-worth rows need a place in Kasboek to land (see the open question about
    investments, net worth over time and a year view).
12. **Investments.** Investment accounts per broker: money paid in, portfolio value at the end of
    each month (typed in or imported), and a portfolio chart.
13. **Net worth over time.** Current accounts + savings + portfolio per month, with a chart, and the
    year-end value.
14. **Year view.** Income vs spending for all 12 months, totals per category per year, and a
    comparison of years (the overviews a yearly spreadsheet gives).
15. **Number and date format, each set separately.** Not tied to a language or country: choose
    the decimal mark (`,` or `.`), the thousands separator (`.` `,` space, `'` or none), where the
    currency symbol goes and whether it is a symbol or code, how negative amounts look, the date
    order (DMY/MDY/YMD), the date separator, and the first day of the week. Presets only fill these
    in; every option can still be changed.
16. **Accounts in different currencies.** Each account has its own currency and amounts are stored
    and shown exactly as the bank reports them. One main currency for overviews, budgets and net
    worth: other currencies are converted at the rate of the transaction's own date (net worth at
    month-end rates). Rates from the European Central Bank's free daily reference rates (only the
    public rate list is downloaded, nothing is sent), stored locally; can be switched off in favour
    of rates typed in by hand. Converted figures are marked as such, originals stay visible.
17. **More languages.** English, Dutch (Flemish), French, German, Spanish (Spain), Spanish (Latin
    America), Portuguese (Portugal), Portuguese (Brazil), Italian, Polish and Turkish; others can be
    added as one file each. Language is separate from the number and date format (item 15).
18. **Other AI providers (OpenAI-compatible).** Besides Claude, any provider with an
    OpenAI-compatible chat API: ready-made setups for Claude, Mistral, Groq, DeepSeek, Ollama,
    LM Studio, OpenRouter, Together, Fireworks and Gemini, plus a custom endpoint. Each with its
    own key (kept in the encrypted data), base URL and model. Local options (Ollama, LM Studio)
    keep everything on the computer. Tool use and confirmations work the same; providers without
    tool calling get chat without changes.
19. **Automatic release step**: GitHub returned 403 when the workflow created the release, even with
   Contents: write (most likely a tag ruleset). Find the cause so tagging a version publishes it.

## Later, maybe

- **Phone app (iPhone / Android).** Would build on sync (item 8): first view the overview and
  budgets, later quick edits (categorise, add a transaction, budgets). Electron doesn't run on
  phones, so this is a separate app reading the same encrypted sync files. Not planned yet.
