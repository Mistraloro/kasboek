Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.15 (0.15.2)

**New**
- **Erasing is recoverable.** Erased data, including its safety backups, is kept for 30 days. On the Setup screen you can restore it with the original password or recovery key. If your account is tied to this device (passwordless mode), Windows Hello or Touch ID is asked before anything is erased. A failed erase puts everything back.
- **Importing a file or restoring a backup starts from safe settings.** AI settings and keys, permissions, MCP, auto-backup, assistant memory and sync are reset, and Kasboek tells you what was reset. Joining a sync keeps its sync key.

**Fixes and safety**
- **Windows Hello now works** (setup, unlock, and the checks before erasing or changing settings). On some computers the prompt was silently never shown. Each Hello answer (not set up, turned off by a policy, busy, too many failed attempts) has its own message, and `startup.log` records how Hello went.
- **The recovery key check is no longer skipped** when you set up with Windows Hello: the setup screen stays until you have typed the last group of the key (and finished or skipped two-factor).
- **Passwordless mode** is only offered when your computer protects the key itself. Importing a passwordless export on a computer without that asks you for a new password.
- **CSV export** is safe against text that a spreadsheet could read as a formula.
- **Passwords:** re-entering your password for sensitive actions has the same attempt limit as unlocking.
- **Updates:** update file names and checksums are checked more strictly.
- **Stricter check** that only Kasboek's own pages can call the app's backend.

Everything that came in 0.14 (WebDAV sync, the Claude Desktop tray, many more CSV formats, the graphics card setting, the Windows on ARM fix and more) is listed on the 0.14.1 release.

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
