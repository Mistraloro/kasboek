Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.16 (0.16.0)

**New**
- **Keep Kasboek running in the tray when you close the window** is now a setting (Settings → General), off by default. With it off, closing the window quits Kasboek (on a Mac it stays in the Dock until you quit). With it on, closing hides it in the tray. If Claude Desktop starts Kasboek’s connection while Kasboek isn’t running, Kasboek still starts in the tray, locked. Closing its window with the setting off quits it, and Claude Desktop starts it again the next time it needs it.
- **Opening Kasboek from its shortcut, the Start menu or the taskbar while it is already running brings the window to the front**, also when it was hidden in the tray or minimised.
- **A new update window on Windows.** Updating no longer flashes terminal windows: Kasboek closes, a small Kasboek window shows the installation progress, and Kasboek opens again by itself. If the update cannot start, Kasboek stays open and tells you. If it cannot install, Kasboek opens again at the old version and says why.

Everything that came in 0.15 (recoverable erase, import and restore starting from safe settings, Windows Hello fixes and more) is listed on the 0.15.2 release.

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
- **Updating from 0.15.x** still uses the old update screen once (terminal windows may flash); the new update window appears from the update after 0.16.0.
- The **tray option**, the **shortcut behaviour** and the **new update window** are new in this version and have not yet been tested on Windows 11; please report anything odd.
