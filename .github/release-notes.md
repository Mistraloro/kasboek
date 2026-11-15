Kasboek — a private, local-first budget app with an AI assistant built in. Your data stays on your computer, encrypted and locked to your computer and login.

## What’s new in 0.10

- **Sync between computers** through a cloud folder you already use (OneDrive, Google Drive, Dropbox, iCloud Drive). Only encrypted files go into the folder; changes merge per field, and clashes are shown, not lost.
- **Net worth and investments**: account types, recorded values for portfolios and loans, gain against what you paid in, and net worth over time.
- **Year view**: twelve months per category side by side, and every year compared.
- **Accounts in other currencies**, converted at the rate of each transaction’s date (ECB reference rates or your own).
- **Your number and date formats**, each part chosen separately, independent of language.
- **Languages**: English, Nederlands, Français, Deutsch, Español (España and Latinoamérica), Português (Portugal and Brasil).
- **Choose your AI**: Claude, or Mistral, Groq, DeepSeek, Gemini, OpenRouter, Together, Fireworks, a local model with Ollama or LM Studio, or any OpenAI-compatible server.
- **Check a CSV with your AI**: it categorises the rows, makes names and descriptions readable, and suggests rules so the next import sorts itself. It also offers to categorise older transactions that have none. You see what it did, can undo each part, and nothing outside the import changes until you accept.
- **Better duplicate detection**: the bank's own reference is recognised even when the text changes, and rows that look like a transaction already in Kasboek (same amount, a few days apart) are marked "Maybe imported" for you to decide.
- **Bank balance**: enter the balance your bank shows (when adding an account, after an import, or any time in Settings → Accounts) and Kasboek counts the account balance from it, also when you import older history later. A balance column in the CSV is read automatically. When a newer balance doesn't match, Kasboek shows the difference, so a missing or doubled transaction stands out.
- **Rules** can match anywhere, as a whole word or at the start, show what they would catch before you add them, and can be put in order.
- **Claude Desktop and Claude Code** connect with one click (MCP), now also on Windows. Approval cards show which transactions a change touches, and waiting requests can be approved together.
- Stronger passwords, 2FA remembered for 30 days on a computer, automatic backups after important changes, a launch screen, and installers that let you choose your shortcuts.

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
