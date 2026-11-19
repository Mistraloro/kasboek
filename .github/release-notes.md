Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.22.1

(0.22.1 includes everything of 0.22; the 0.22.0 build was never published.)

**Privacy**
- **Account numbers are hidden on screen by default.** An IBAN shows as `BE…1234` (country and last four characters) everywhere: accounts, transactions, import preview, rules and the assistant panel. Hold the small eye next to it to show the full number for a moment; the eye no longer opens the edit window. You can switch this off in Settings → Appearance. Importing a file never switches it off, and it is switched back on after restoring a backup or export or joining sync.
- **The assistant and connected apps (MCP) no longer see account or card numbers, e-mail addresses or international phone numbers (starting with + or 00).** This holds for chat, CSV checks, PDF reading, tips, memory notes and what you type. Your own account number shows as `BE…1234`. Amounts, dates and category names stay readable so the assistant can still answer questions. Hiding also holds for numbers written with dots, slashes or line breaks.
- **Statement headers are never sent.** “Check with your assistant” on a CSV no longer sends the lines above the header row (they can hold your name and address), and the assistant can't move the header up past the one Kasboek found, so you are asked for your agreement again once. For a PDF, only the rows of the transaction table are sent: everything above the table and the top of every later page is left out.
- The privacy rules are summarised at the top of the README.

**Fixes**
- If upgrading the database fails (for example a database from a newer Kasboek), Kasboek now closes the file properly instead of leaving it open.
- The assistant can preview a rule for an account number (IBAN) from a transaction.
- Fixed costs, and rules created from them, work with account numbers in their names.

If you installed 0.20.0 or 0.21.0 and the “Update” button doesn’t find this version, download the installer once from this page. From 0.21.1 on, updating works normally.

Everything that came before is listed on the 0.21.1, 0.21.0 and 0.20.0 releases.

## Download

| System | File |
|---|---|
| Windows (most PCs) | `Kasboek-…-win-x64.msi` |
| Windows on ARM (Snapdragon) | `Kasboek-…-win-arm64.msi` |
| macOS with Apple Silicon (M1 and later) | `Kasboek-…-mac-arm64.dmg` |
| macOS with an Intel chip | `Kasboek-…-mac-x64.dmg` |
| Linux | `.AppImage` (any distribution) or `.deb` (Debian/Ubuntu), x64 or arm64 |

All builds are 64-bit. Installing over an earlier version keeps your data. Kasboek needs nothing else installed. An export made on one system imports on any other with your login.

## First start

These builds are not yet signed with a certificate:
- **Windows** shows “Windows protected your PC”: click **More info → Run anyway**.
- **macOS** says it can’t verify the developer: **right-click Kasboek → Open**, once. On macOS 15 and later that shortcut no longer works: open **System Settings → Privacy & Security** and click **Open Anyway**.

## Good to know

- **Updating from 0.12 or 0.13**: their update window can’t be clicked, so download the installer from this page once. From 0.14 on, the "Update to …" button works.
- **Windows Hello** has been tested on a real Windows 11 computer. **Touch ID** has only been tested in simulation, not yet on a real Mac; please report anything odd.
- **Updating from 0.15.x** still uses the old update screen once (terminal windows may flash). From 0.16.1 on, the new update window is used.
- The **new update window** has been tried in a real update on Windows 11; please report anything odd.
- **PDF import** and the assistant’s PDF reading have only been tried on invented statements and two real layouts, not yet on a wide range of real bank PDFs.
