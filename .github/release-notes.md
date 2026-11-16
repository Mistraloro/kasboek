Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.13

**New**
- **Transfers between accounts in different currencies** are recognised at that day's exchange rate. What the bank kept on the conversion is shown and counted as a fee (in "Fees & taxes"); you can change it per transfer, for example to the exact cost on your statement. Accounts get an optional "Exchange cost (%)".
- **Settings in tabs**: General, Accounts, Security, Backups & sync, and Assistant.
- **Welcome window**: also the number and date style, exchange rates from the ECB (on by default), and adding Kasboek to Claude Desktop and Claude Code.
- **Claude apps**: Settings shows whether Claude Desktop or Claude Code is connected now, or when it last used Kasboek.
- The **version** is shown at the bottom of the menu.

**Fixes**
- Windows Hello now opens in front of Kasboek instead of behind it.
- Adding Kasboek to Claude Desktop while Claude Desktop was open could be undone when it quit. Kasboek now asks you to close it first.
- Claude Code no longer shows "Update" when Kasboek is already added and up to date.
- Installer: no more warning 1946 about the shortcut; shortcuts left by an older install are replaced.
- Uninstalling removes everything Kasboek added (program, shortcuts, registry entries, caches, and its entries in Claude Desktop and Claude Code). Your data stays, unless you run the installer again, choose Remove and tick "Also delete my Kasboek data". Sync and backup folders are never touched.

Everything that came in 0.12 (fixed costs, savings goals, updates from inside Kasboek, permissions, memory and more) is listed on the 0.12.0 release.

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
- **macOS** says it can’t verify the developer: **right-click Kasboek → Open**, once.

## Good to know

- **Syncing between computers? Update all of them.** A computer on an older version ignores the newer settings (such as an account's exchange cost) it receives.
- From 0.12.0 you can update from inside Kasboek: the "Update to 0.13.0" button appears at the top.
- Windows Hello and Touch ID were only tested in simulation; please report anything odd.
