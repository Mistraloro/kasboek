Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.15 (0.15.0)

**New**
- **Erasing is recoverable.** Erased data, including its safety backups, is kept for 30 days. On the Setup screen you can restore it with the original password or recovery key. If your account is tied to this device, you must first pass Windows Hello or Touch ID before you can erase. A failed erase puts everything back.
- **Importing a file or restoring a backup starts from safe settings.** AI settings and keys, permissions, MCP, auto-backup, assistant memory and sync are reset (sync is switched off and its local files removed), and Kasboek tells you what was reset. Joining a sync keeps its sync key.

**Fixes and safety**
- **Windows Hello during first setup:** three causes that could stop the Hello prompt from appearing, or leave the option greyed out, are fixed in the code: a failed helper no longer blocks the prompt, a failed availability check is retried instead of being remembered until restart, and quote characters in the prompt text no longer break it. This is not yet tested on a real Windows PC.
- **Passwordless mode** is only offered when your computer protects the key itself (its key store). Importing a passwordless export on a computer without that asks you for a new password.
- **CSV export** neutralises text that a spreadsheet could read as a formula.
- **Passwords and saving:** re-entering your password for sensitive actions has the same attempt limit as unlocking. A failed account save no longer leaves memory and disk out of step. A join file picked while locked is refused and its temporary file removed.
- **Updates** only accept plain file names, and checksums are matched by exact file name.
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
- **macOS** says it can’t verify the developer: **right-click Kasboek → Open**, once.

## Good to know

- **Updating from 0.12 or 0.13**: their update window can’t be clicked, so download the installer from this page once. From 0.14 on, the "Update to …" button works.
- Windows Hello and Touch ID were only tested in simulation; please report anything odd.
