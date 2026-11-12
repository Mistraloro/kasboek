# Kasboek — plan

A simple, clean, local-first budget app for the desktop, which Claude (and later any LLM) can operate.

## Decisions

| Topic | Decision |
|---|---|
| Platform | Desktop app. **Windows first**; macOS and Linux build from the same code. |
| Stack | Electron + React + TypeScript (electron-vite), Tailwind CSS |
| Storage | Local only. One SQLite file, **encrypted** (SQLite3 Multiple Ciphers, ChaCha20-Poly1305) |
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
* **Password**: the master key is unlocked with your password (scrypt, N=2¹⁷).
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
password ─scrypt─►┐
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

* **In-app chat** (side panel, already in the layout): Claude uses the operation registry as tools.
  Questions are answered from your data; anything that changes data shows a confirmation card first.
* **Provider adapter**: Claude through the official Anthropic SDK now; the adapter interface keeps
  other LLMs possible later.
* **API key** is stored in the OS keychain like the database key, never in the renderer, and
  requests go from the main process only.
* **MCP server**: `Kasboek.exe --mcp` runs a stdio MCP server that talks to the running app over a
  local, authenticated channel (it doesn’t open the database a second time). Claude Desktop or
  Claude Code can then work with your budget.

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
| 5 | Claude: API key and model settings, chat panel with tools and confirmations, CSV assistant | |
| 6 | MCP server for Claude Desktop / Claude Code | |
| 7 | Tests with bank fixtures, polish, docs, release builds for all three OSes | |

## Brand

`assets/brand/` holds the source SVGs: `icon.svg` (app icon), `icon-small.svg` (16–32 px),
`icon-light.svg`, `mark.svg` (bare mark, follows the text colour). `npm run icons` regenerates
`build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icons/*.png` (Linux) and the
window icon. The mark is a **K** whose bright upper arm stands for money in and dimmed lower
arm for money out.
