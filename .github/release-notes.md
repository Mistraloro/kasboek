Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.18 (0.18.0)

**New**
- **Import bank statements as PDF.** Drop or choose a PDF on the Import page. Kasboek reads it on your computer (nothing is sent anywhere), finds the transactions table and shows the same preview as a CSV. It checks that the amounts add up to the closing balance of the statement, and for credit card statements it offers a one-click “Flip signs” hint. Statements printed as blocks and turned landscape pages are supported. Scanned PDFs (photos without text) and password-protected PDFs are not supported; Kasboek tells you so.
- **“Read with” your assistant** when Kasboek cannot read a layout or the totals don’t add up. You confirm every time, and Kasboek shows exactly what is sent: only the text of the statement, with account and card numbers hidden and your name and address left out. The PDF itself is never sent. Every row the assistant returns is checked against the PDF text and shown to you before anything is saved, and a PDF import from the assistant always asks for your OK. It works with Claude and with OpenAI-compatible providers. A separate setting chooses the model that reads PDF statements (for Claude, the cheapest model by default).
- **Clearer assistant settings.** Each provider remembers its own address and models, and you can add several OpenAI-compatible providers (“Other”) with their own names. The layout is clearer, with a model picker that lists all models, a “Model for reading files”, and the reasoning rows under their model. Ollama Cloud and other custom providers now count as set up once they have an address, a model and, if they are not local, a key.
- **A hold-to-show eye** in every password field.

**Fixes**
- Clicking next to a dialog no longer closes it and loses what you typed. Escape or the close button asks first in add/edit account, goals, bank balance and net worth value.
- Dates you type now follow your date format setting everywhere, and hints show today’s date in your format.
- “Install and restart” shows “Preparing the update…” right away instead of looking frozen.

PDF import and the assistant’s PDF reading have so far been tried on invented statements and two real layouts only. Please report layouts that don’t read well.

Everything that came in 0.16 (the tray option, opening from the shortcut, the new update window) is listed on the 0.16.1 release.

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
