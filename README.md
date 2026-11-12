# Kasboek

A simple, local-first budget app for Windows (macOS and Linux supported by the same code).
Your data stays on your computer, encrypted. Claude can help import and clean bank CSVs.

See [PLAN.md](PLAN.md) for the full plan, security model and roadmap.

## Run it

Requirements: Node.js 22.12 or newer.

```bash
npm install        # also builds the encrypted-SQLite module for Electron
npm run dev        # start the app with hot reload
```

## Build an installer

Build each platform on that platform (or use the GitHub Actions workflow, see below).

```bash
npm run dist:win     # release/<version>/Kasboek-Setup-<version>-x64.exe
npm run dist:mac     # .dmg (unsigned until a signing certificate is set up)
npm run dist:linux   # AppImage and .deb
```

If `npm install` on Windows fails while building `better-sqlite3-multiple-ciphers`, install the
“Desktop development with C++” workload from Visual Studio Build Tools and run it again.

**CI builds**: `.github/workflows/build.yml` builds Windows, macOS and Linux packages when you
push a tag like `v0.1.0`, or when you run it by hand from the Actions tab.

## Checks

```bash
npm run typecheck
npm test            # runs under Electron's Node, so the native module matches
```

## Where your data lives

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Kasboek` |
| macOS | `~/Library/Application Support/Kasboek` |
| Linux | `~/.config/Kasboek` |

* `kasboek.db`: encrypted database
* `keystore.json`: the database key, protected by the operating system
* `safety-backups/`: copies made automatically before a restore

Back up with **Settings → Backups**. A `.kasboek` backup opens with your backup password on any computer.

## Project layout

```
src/shared/     operation contract and types (used by every side)
src/core/       database, migrations, operations, backup file format (no Electron)
src/main/       Electron main process: window, security, IPC, keychain, backups
src/preload/    the small bridge exposed to the page
src/renderer/   React UI, theme tokens, i18n strings (src/renderer/src/i18n/locales)
assets/brand/   logo and icon sources;  npm run icons  regenerates build/ icons
tests/          unit tests
```

## Adding a language

Copy `src/renderer/src/i18n/locales/en.json` to e.g. `nl.json`, translate the values, and add
it to `LANGUAGES` in `src/renderer/src/i18n/index.ts`.
