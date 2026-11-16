Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.14

**Fixes**
- **Windows on ARM (Snapdragon): no more white window.** On some graphics drivers, Kasboek opened as an empty white window. On Windows on ARM, Kasboek now draws without the graphics card by default. On any computer, if the graphics card fails to show Kasboek when it starts, Kasboek restarts once without it and remembers that.

**New**
- **Graphics card** setting (Settings → General): automatic (recommended), always or never. It also says whether Kasboek draws with the graphics card right now, and why not.
- **CSV import reads the exports of many more banks and payment apps**, from Europe, the UK, the Americas and beyond, with headers in many languages: ING, Rabobank, ABN AMRO, KBC, Belfius, BNP Paribas, Deutsche Bank, Sparkasse, DKB, N26, Revolut, Wise, PayPal, Monzo, Lloyds, Barclays, Chase, Bank of America, Santander, Nubank, Boursorama and more. It also understands:
  - a separate debit/credit column;
  - amounts with "DR"/"CR" or a currency sign;
  - dates with month names or a time.
- A **start-up log** (`startup.log` in the data folder) records technical facts only: version, system, graphics card and start-up steps, never your data. If Kasboek doesn't open properly, that file helps find out why.

Everything that came in 0.13 (transfers between currencies with exchange cost, settings in tabs, a fuller welcome window, the cleaner uninstall and more) is listed on the 0.13.0 release.

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

- **Had a white window on 0.13 or earlier?** Install this version over it with the MSI; your data stays.
- From 0.12.0 you can update from inside Kasboek: the "Update to 0.14.0" button appears at the top.
- Windows Hello and Touch ID were only tested in simulation; please report anything odd.
