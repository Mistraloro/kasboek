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

## Security and backups

**On this computer**
* The database file is encrypted with a random 256-bit key.
* That key is protected by the operating system (DPAPI on Windows, Keychain on macOS,
  GNOME Keyring/KWallet on Linux) through Electron `safeStorage`. Copying the files to
  another machine or user account doesn’t open them.
* The app warns in Settings → Security if no OS protection is available (Linux without a keyring).
* Electron hardening: context isolation, sandboxed renderer, strict CSP, no navigation or
  pop-ups, all permission requests denied, one IPC channel that only accepts the app’s own page.
  Packaged builds set Electron fuses (no `ELECTRON_RUN_AS_NODE`, no `--inspect`,
  no `NODE_OPTIONS`, asar integrity check).

**Backups (`.kasboek` files)**
* One file containing the still-encrypted database plus its key, sealed with **AES-256-GCM** using
  a key derived from your **backup password** (scrypt, N=2¹⁷). Nothing is written to disk unencrypted.
* Restoring needs only the backup password, so it works on a new computer.
* Tampering or a wrong password is detected (authenticated encryption).
* **Back up now** to any location, or **automatic daily backups** to a folder you pick
  (OneDrive / iCloud Drive / Dropbox / USB drive), keeping the last N.
* Before a restore, the current data is saved as a safety backup automatically.
* The backup password is also kept in the OS keychain so automatic backups can run unattended.
  Write it down: without it a backup can’t be opened.

## CSV import (Phase 3–4)

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

## Claude (Phase 4) and MCP (Phase 5)

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
| 1 | Project setup, theme (dark/light, green), layout, encrypted DB + schema, OS keychain, encrypted backups (manual, automatic, restore), i18n, accounts, app icons, packaging config | **Done** |
| 2 | Transactions list/edit, categories, monthly budgets, overview with real numbers and charts | Next |
| 3 | CSV pipeline in code: parse, Belgian bank profiles, preview, duplicate check, import | |
| 4 | Claude: settings for API key and model, chat panel with tools, CSV assistant | |
| 5 | MCP server | |
| 6 | Tests with bank fixtures, polish, installer signing, release builds for all three OSes | |

## Brand

`assets/brand/` holds the source SVGs: `icon.svg` (app icon), `icon-small.svg` (16–32 px),
`icon-light.svg`, `mark.svg` (bare mark, follows the text colour). `npm run icons` regenerates
`build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icons/*.png` (Linux) and the
window icon. The mark is a **K** whose bright upper arm stands for money in and dimmed lower
arm for money out.
