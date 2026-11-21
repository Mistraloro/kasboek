Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.22.2

Everything in 0.22.1 is included.

**Privacy**
- When text is cut to a maximum length before it is sent to the assistant or to connected apps, a long account or card number sitting at the cut could be left partly visible. Text is now masked first and cut afterwards (also for very long inputs, which stay fast).

Nothing else changed from 0.22.1.

If you have 0.22.1, you get this version through the Update button. Updating from 0.21.1 and later works normally.

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
