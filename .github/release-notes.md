Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.21.1

**Changes**
- **Kasboek is now open source under the GPL-3.0 licence.** The licence is in the repository, in the app (Settings → About, and a copy in the installed files) and in the README. The copyright holder is divemost.
- **The project has moved to a new GitHub address: `github.com/divemost/kasboek`.** The old address redirects for now.

**Important if you installed 0.20.0 or 0.21.0:** because of the new address, the “Update” button in those two versions may not be able to download this update. If that happens, download the installer once from this page (below) and run it; your data is kept. From this version on, updating works normally again.

Everything that came in 0.21 (XML statement import, a minimum password length of 12) is listed on the 0.21.0 release, and 0.20 on the 0.20.0 release. Note: for XML files, “Flip signs” is not offered, because the signs come from the file itself.

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
