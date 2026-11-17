Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.20 (0.20.0)

**New**
- **Import bank statements as PDF.** Drop or choose a PDF on the Import page. Kasboek reads it on your computer (nothing is sent anywhere), finds the transactions table and shows the same preview as a CSV. It checks that the amounts add up to the closing balance of the statement, and for credit card statements it offers a one-click “Flip signs” hint. Statements printed as blocks and turned landscape pages are supported. Scanned PDFs (photos without text) and password-protected PDFs are not supported; Kasboek tells you so.
- **“Read with” your assistant** when Kasboek cannot read a layout or the totals don’t add up. You confirm every time, and Kasboek shows exactly what is sent: only the text of the statement, with account and card numbers hidden and your name and address left out. The PDF itself is never sent. Every row the assistant returns is checked against the PDF text and shown to you before anything is saved, and a PDF import from the assistant always asks for your OK. It works with Claude and with OpenAI-compatible providers. A separate setting chooses the model that reads PDF statements (for Claude, the cheapest model by default).
- **Clearer assistant settings.** Each provider remembers its own address and models, and you can add several OpenAI-compatible providers (“Other”) with their own names. The layout is clearer, with a model picker that lists all models, a “Model for reading files”, and the reasoning rows under their model. Ollama Cloud and other custom providers now count as set up once they have an address, a model and, if they are not local, a key.
- **Suggestions on the Overview.** A collapsible card with tips found on your computer from your own data: a fixed cost that went up or was charged twice, budgets over or near their limit, a category that rose, unusual payments, a low balance. With “Get tips from your assistant” it writes them up for you: only after you agree (asked once per provider, with the exact text shown), only a short summary is sent (masked, rounded names and amounts; never account or card numbers, balances, income or your transactions), and Kasboek fills in every amount itself. You can hide a tip or mark it not useful, and switch the card off in Settings.
- **Fixed costs can be corrected.** On the Fixed costs page every row has a menu: “Not a fixed cost” (with Undo, and a Hidden list to count it again), “Show payments” and “Change category” (optionally with a rule for future payments).
- **Clearer permission names for the assistant:** Ask first, Smart, Full access and Custom, each with a short description of what it does and what still always asks.
- **The assistant’s thinking is collapsed** by default, follows the newest text when you open it, and no longer covers the chat.
- **“Check with your assistant” on imports asks first**, like the PDF reading and the tips: you see exactly what is sent (payee and description text, your rules and the assistant’s remembered notes, all with account and card numbers hidden), and your agreement is remembered per provider, address and model.
- **Safer AI reading of PDFs:** the sign of an amount (minus, brackets, CR, DR) is always taken from the statement’s own text, so a payment can no longer be read as income; IBANs stuck to other text are hidden too; and while the assistant reads, editing rows is switched off.
- **The assistant can see the page you have open** (Transactions, Budgets, Fixed costs, Overview): ask about “this transaction” without describing it. A chip above the input shows what it sees and can be switched off; there is also a setting. Account and card numbers are hidden, and it never sees more than the rows on screen.
- **A hold-to-show eye** in every password field.
- **Faster, clearer start.** A launch window with a progress bar shows right away; the main window appears only once its first screen is drawn (no more blank window, also on Windows on ARM). The program loads far less code at start, pages and languages load when you need them, and the Windows Hello check runs after the first screen. A startup.log in the data folder records the timings (technical facts only).

**Fixes**
- The assistant no longer stops silently after its first message, and a “working” line shows while it runs a tool.
- The Stop button on the assistant’s import check works again, and locking stops a running check. A backup or sync made at the very moment of locking can no longer be unreadable. A failure while starting now shows a message instead of leaving only the launch window.
- Dates like 01-10-2026 in statement text are no longer masked in what the assistant sees.
- Clicking next to a dialog no longer closes it and loses what you typed. Escape or the close button asks first in add/edit account, goals, bank balance and net worth value.
- Dates you type now follow your date format setting everywhere, and hints show today’s date in your format.
- “Install and restart” shows “Preparing the update…” right away instead of looking frozen.
- Locking Kasboek now stops any running assistant job. Actions that opened an input box that did not work on Windows (fix a date, rename a category, save a search) now use proper dialogs. Errors from the assistant are translated and no longer show a raw placeholder.
- Syncing between versions: changes for a table an older Kasboek does not know yet are kept and applied once it is updated (update all your computers).
- Reviews of long imports (and PDF reading) no longer fail with “too large for one answer”: a part whose answer is cut off is split and retried, and a part that still fails keeps the others.

PDF import, the assistant’s PDF reading and the tips have so far been tried on invented data (and two real PDF layouts) only. Please report anything that doesn’t read or look right.

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
