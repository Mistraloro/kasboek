Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.11

**New**
- **Fixed costs**: subscriptions, rent, insurance and salary found from your transactions, with what is still due this month, price changes and late payments.
- **Savings goals**: an amount by a date, following an account or kept by hand, with what to put aside per month.
- **Transfers between your own accounts** are paired (automatically when the account number matches) and count as neither income nor spending.
- **Split a payment** over several categories; **refunds** and shares paid back lower spending instead of counting as income.
- **Warnings** on the Overview (and as notifications): a budget at 80% or 100%, or a balance heading below zero before payday.
- **Monthly review** by the AI, from a button on the Overview.
- **Bank balance**: enter what your bank shows, and Kasboek counts from there and shows any difference later.
- **Export**: transactions as CSV, and a year report as PDF.
- **Transactions**: rename or pair a selection, and saved searches. **Month picker**: click the month to jump to any month and year.
- **Tray icon**: whether Claude apps are connected, with "Stop Claude connection" and Quit.

**Assistant**
- **Permissions**: choose what the assistant may change by itself and what waits for your OK, like Claude's permission modes. "Always ask" stays the default.
- **Memory**: the assistant can remember facts and preferences between conversations ("remember that I get paid on the 25th"). Kept encrypted on this computer only, never synced, visible and editable in Settings; account and card numbers are refused.
- **Reasoning**: turn the model's thinking off or set its level, per model and provider, right under the message box.

**CSV import and Check**
- Pending payments (Hello bank! “2026-”) are no longer imported twice once booked.
- Duplicates are also found by bank reference, and rows the bank reworded are marked "Maybe imported".
- Check runs in parts with progress, shows its reasoning in the assistant panel, suggests safe rules, also sorts older uncategorised transactions (only when you accept), keeps a transfer's own message, and can be undone part by part.
- The bank's own text is kept next to the tidied one, so rules keep working, and names you tidied are used again next time.
- The open import and a running check stay when you switch tabs.

**Fixes**
- Mistral: no more "answer was cut off", time limits and retries, and the chat no longer stops working after Stop.
- Net worth ranges longer than your history are disabled, with an explanation.
- "Today" follows your own clock, not UTC; a new account and its balance are saved together; many smaller fixes from an outside review.
- The installer no longer contains the source code.

## Download

| System | File |
|---|---|
| Windows (most PCs) | `Kasboek-…-win-x64.msi` or `Kasboek-…-win-x64.exe` |
| Windows on ARM (Snapdragon) | `Kasboek-…-win-arm64.msi` or `…-win-arm64.exe` |
| macOS (Intel and Apple Silicon) | `Kasboek-…-mac.dmg` |
| Linux | `.AppImage` (any distribution) or `.deb` (Debian/Ubuntu), x64 or arm64 |

All builds are 64-bit. Installing over an earlier version keeps your data. An export made on one system imports on any other with your login.

## First start

These builds are not yet signed with a certificate:
- **Windows** shows “Windows protected your PC”: click **More info → Run anyway**.
- **macOS** says it can’t verify the developer: **right-click Kasboek → Open**, once.

## Good to know

- **Syncing between computers? Update all of them.** A computer on an older version ignores the newer rule settings (whole-word matching, order) it receives.
- Windows Hello and Touch ID were only tested in simulation; please report anything odd.
- If you used 0.9 with a short password, Kasboek asks for a stronger one at the next unlock.
