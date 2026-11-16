# Kasboek: changes since build 14 (824f4f3), for review

**What this covers**
- **Range:** branch `ccr-0f0084e8-2jcj1g`, from `cf32f63` up to the 0.11.0 version commit. Sections 1–5 cover up to `8679bc2`; section 6 covers what came after (reasoning, permissions, memory).
- **Version:** 0.12.0 (0.11.x were test builds only, never released).

**Checks run**
- 120 vitest tests pass; typecheck and the i18n check are clean.
- Electron end-to-end flows were run with a fake OpenAI-compatible server and a real 752-row Hello bank! export:
  - a Check in 3 parts, with one part timing out;
  - reasoning streamed into the assistant panel;
  - switching tabs while a check runs;
  - the tray menu;
  - the PDF/CSV export;
  - the net worth ranges and the month picker.
- Nothing was run against the live Mistral or Anthropic APIs.

**Layout and rules for the reviewer**
- **Layout:** `src/core` holds the logic (no Electron), `src/main` the main process, `src/renderer` the React UI, `src/shared` the contract, types and formats.
- **Writes:** every change goes through an op (`src/core/ops.ts`, `src/main/ipc.ts`). Assistant and MCP changes wait for approval.
- **Decisions to keep:**
  - the AI tidies the bank text (there is no per-bank cleaner);
  - logs are in English;
  - there is no Excel importer.

**Migrations**
- **Version:** schema 7 at build 14, now 11.
- **Upgrade test:** `tests/upgrade.test.ts` upgrades a schema-7 database.
- **The migrations:**
  - **8:** placeholder references become NULL (with the fingerprint recomputed), and short `contains` rules become `word` rules.
  - **9:** `transactions.bank_counterparty` and `bank_description` are added. The rules table is rebuilt to allow `field = 'iban'`, keeping ids and uids, and its sync triggers are made again.
  - **10:** adds `transactions.transfer_pair`, the tables `transaction_splits` and `goals` (both synced), and the view `tx_lines`.
  - **11:** the table `memories` (not synced).

---

## 1. Fixes from the build 14 review (items 1–22)

| # | What changed | Where |
|---|---|---|
| 1 | Placeholder references (`2026-`, empty, `-`, `0`, a year alone) count as none. A new row with a real reference also matches an earlier pending row through its fingerprint without the reference (path 2b). A possible duplicate is only excluded on a conflicting reference when the existing reference is a real one. A migration cleans the stored rows. | `realReference` in `csv/normalize.ts`; `buildRows` in `import.ts`; migration 8 |
| 2 | Check runs in parts of 80 groups, 3 at a time. Group numbers in the context are global. Only part 1 carries the column check and the flagged rows. Each part has its own 4-minute limit (`KASBOEK_CHECK_LIMIT_MS` shortens it, dev builds only). Parts that finish are kept, with a note naming the failed ones. Progress arrives as `import.checkProgress` events. | `batches`, `mergePlans`, `pool`, `runParts` in `main/assistant/csv.ts` |
| 3 | "Apply selected" categorises only transactions still without a category, and reports how many it skipped. | `categorizeTransactions(…, { onlyUncategorised })`, `applyCheckProposals` |
| 4 | Option (a): the bank's own text is stored next to the readable text. Rules, `previewRule`, `applyRule`, `checkRules` and `similarity()` read both (`RuleText`, `RULE_COLUMNS`, `ruleText()`). New rule field `iban` matches the counterparty IBAN exactly, after normalising. **Also new:** `learnedNames()`. An import row whose bank text was tidied earlier gets that readable name and description. Without this, a rule made on a readable name would never fire on the next raw import. | `finance.ts`, `import.ts`, migration 9 |
| 5 | `groupKey` adds the normalised communication for transfers (rows with a counterparty IBAN), except structured communications (`+++…+++`). | `assist-plan.ts` |
| 6 | `accounts.create` and the first bank balance are saved in one database transaction. | `ops.ts` |
| 7 | `localToday()` replaces the `toISOString().slice(0,10)` "today" defaults. | `shared/month.ts` |
| 8 | `balances.set` is refused for investment accounts, and `valuations.set` for bank accounts. A new investment account gets a valuation at creation. | `balance.ts`, `ops.ts` |
| 9 | The approval text for `import.commit` names the rows, total, dates, account and the closing balance it records (`commitSummary`). A refused balance is logged and returned as `balanceNote`. | `import.ts`, `tools.ts` |
| 10, 11 | `settleTurn()` handles a turn that stops or fails: an unanswered tool call is dropped; when tools already ran, the turn is closed with an assistant note; when nothing ran, the turn is taken back. Two user messages never follow each other. | `main/assistant/chat.ts` |
| 12 | `request()` returns `Open {res, touch, close, timedOut}`. The time limit covers getting an answer; streams then use a 90-second silence limit (`IDLE_MS`), with a `ProviderError` saying "no answer for …". `readJson` covers reading non-streamed answers. | `openai.ts` |
| 13 | The body of a failed answer is cancelled before retrying. When `Retry-After` is over 20 s there is no retry (`retryDelay` returns null). | `openai.ts` |
| 14 | `json()` retry order: on an error mentioning tokens it retries the strict schema at 8192 tokens; only after that does it fall back to `json_object`. | `openai.ts` |
| 15 | A second Check keeps the first check's snapshot and merges the part indices. The summary shows what "Apply selected" already saved (`CheckSummary.applied`). | `csv.ts`, `import.ts`, `Import.tsx` |
| 16 | Short `contains` rules become `word` rules. | migration 8 |
| 17 | `maskIban` also finds IBANs stuck to other text (`(?<![A-Z])`). It checks the country length and the mod-97 checksum. | `csv.ts` |
| 18 | `reorderRules` writes only the priorities that changed. | `finance.ts` |
| 19 | Locking, or switching MCP off, broadcasts `mcp.expired` for each waiting approval. | `bridge.ts` |
| 20 | Settings shows the build commit next to the version (`__BUILD_COMMIT__`, from `GITHUB_SHA` or `git rev-parse`). The version rule is in `CLAUDE.md`. | `electron.vite.config.ts`, `ipc.ts` |
| 21 | The package check is now `scripts/check-package.sh`. It was run locally: it passes on a clean package and fails on one with a planted `src/foo.ts`. | `.github/workflows/build.yml` |
| 22 | The release notes say to update every synced computer. | `.github/release-notes.md` |

## 2. Improvements the user asked for

- **The open import survives switching tabs**
  - The import screen loads `import.current` and `import.assistStatus` when it opens.
  - A check's result arrives as an `import.checkDone` event, not as the result of the invoke.
  - Closing the import cancels its check.
- **Check reasoning in the assistant panel**
  - `checkActivity()` in `chat.ts` adds a display-only message with `check: {fileName, groupsDone, …}`, one reasoning section per part, and the notes at the end. The chat history the model sees is unchanged.
  - `openai.json()` streams when `onThinking` is given, and still reads plain-JSON answers.
  - The Claude path uses `thinking: {type: 'adaptive', display: 'summarized'}`.
  - The notes are written in `noteLanguage`, the app's language.
- **Tray icon** (`src/main/tray.ts`)
  - It shows whether the connection is on, and when a Claude app last used it.
  - The menu has "Stop/Allow Claude connection" (sets `mcpEnabled` and broadcasts `settings.changed`), "Open Kasboek" and "Quit Kasboek", in a small table of 7 languages.
  - In dev builds, `__kasboekTray` lets tests read and click the menu.

## 3. New features

| Feature | Core | UI | Assistant |
|---|---|---|---|
| **Transfers between own accounts** | `transfers.ts`: `findTransfers` matches the same amount in another account within 3 days. It is sure when the counterparty IBAN is the other account's number. `pairTransfers` sets a shared `transfer_pair` key and a transfer category. `commit` pairs the sure ones at once (`transfersPaired`, `transfersSuggested`). | Transactions → Transfers window; a ⇄ badge; "Separate" in the transaction window | `transfers_find`, `transfers_pair` (approval) |
| **Refunds** | `INCOME_SQL` and `SPENDING_SQL`: money in within a spending category lowers spending, and money out of an income category lowers income. Used by the month, year and years totals. | A hint in the transaction window | n/a |
| **Split transactions** | The `transaction_splits` table. `setSplits` checks that the parts add up to the transaction. Summaries and budgets read the view `tx_lines`. | Split editor in the transaction window | `transactions_split` (approval) |
| **Fixed costs** | `recurring.ts`: same payee, a weekly, monthly, quarterly or yearly rhythm (±20%), a steady amount, 14 months of history. Status paid, due or late (7 grace days), price changes, monthly totals. | The "Fixed costs" page | `recurring_list` |
| **Monthly review** | `review.ts` `monthReview`: each category against the 3 months before, budgets over, and unusual payments (over 2.5× the payee's usual amount, or a large first payment). | A "Review with …" button on the Overview | `summary_review` |
| **Warnings** | `alerts.ts`: budgets at 80% or more, and current accounts with a known balance that would go below zero before the next income, counting the fixed costs due until then. | Overview banners; system notifications in `main/notify.ts`, once per key per run, every 10 minutes | `alerts_list` |
| **Savings goals** | `goals.ts` (synced table): follows an account's balance (converted to the main currency) or an amount kept by hand. Gives the amount per month to the target date. | The "Goals" page | `goals_list`, `goals_create` (approval) |
| **Bulk editing and saved searches** | `renameTransactions`; `searches.save` and `searches.delete` in `settings.savedSearches`, stored in the encrypted database and not synced | Rename, and "Pair as transfer" for 2 selected rows; a saved-search picker | `transactions_rename` (approval) |
| **Export** | `transactionsCsv`: one line per transaction or split part, ISO dates, the person's decimal mark, `;` between fields when that mark is a comma, and a BOM. `main/export.ts` holds the save dialog and the PDF printing: a hidden window on its own session, with JavaScript off and only `data:` URLs allowed. | Year page: "Export CSV" and "Report (PDF)" (HTML built by the UI in its language). Transactions: export of the current filter | n/a |
| **Net worth ranges** | `NetWorth.firstMonth` | Ranges longer than the history are disabled with a tip, the choice falls back, and the chart says where the history starts | n/a |
| **Month picker** | n/a | `MonthNav` (Overview, Budgets): click the month for a year-and-month grid and "This month" | n/a |

## 4. Smaller changes
- Searching transactions also looks at the bank's own text.
- The assistant system prompt says when to use the new tools.
- `installSyncSchema` skips tables that later migrations create. `createSyncTriggers` was split out so a rebuilt or new table can get its triggers.
- The tests for this build are:
  - `tests/review-fixes.test.ts` (extended);
  - `tests/features.test.ts` (new);
  - `tests/upgrade.test.ts` (new);
  - `tests/balance.test.ts` and `tests/sync.test.ts` (extended).

## 5. Known limits and what to look at
- **`learnedNames`:** a tidied name is reused for every row with the same bank text, keyed by `groupKey`. The latest one wins. Check that this can't spread a wrong name.
- **`findTransfers`:** a match on amount only can pair two unrelated payments of the same amount. Those pairs are only suggested, never made automatically.
- **Thresholds:** in `recurring.ts` (rhythm ±20%, 70% steady gaps, 60% alike amounts) and in `review.ts` (2.5×, at least €20). These are first guesses.
- **Notifications:** they run every 10 minutes and once per app run. The Linux and macOS notification permissions were not tested.
- **Approvals:** "Approve all N" covers queued MCP requests of the same op. Also review the tray's "Stop Claude connection" (`setMcp`).
- **Sync between versions:** saved searches are per computer, on purpose. A computer still on 0.10 ignores the new columns and tables it receives.
- **Speed:** with 30,000 transactions and a 752-row import, lists and summaries take 25–85 ms, analyze about 100 ms, a preview after an edit about 80 ms, a commit about 270 ms, and `monthReview` about 300 ms.

## 6. Added after the first review round

### Reasoning per model and provider (`src/shared/reasoning.ts`)
- **Claude:** levels off, low, medium, high, xhigh, max. "Off" exists only for Sonnet 5.5 (`thinking: {type: 'between_tools'}`) and Haiku 5.5 (`{type: 'disabled'}`); Opus 5.5 and Fable 5.2 always think. `claudeEffort()` falls back to "low" when a stored level doesn't exist for the model; `assistant.configure` keeps the stored level valid when the model changes. Otherwise `thinking: {type: 'adaptive', display: 'summarized'}` with `output_config.effort`.
- **Other providers:** default, off, low, medium, high. `reasoningParams()`: DeepSeek gets its `thinking` switch, OpenRouter its `reasoning` object, the rest `reasoning_effort` ("none" for off). "Default" sends nothing.
- **Refusals:** `withFallbacks()` in `openai.ts` retries a 400/422 at most twice: first lowering the output limit to 8192 when the error mentions tokens, then without the reasoning fields when the error is about them. A model is remembered as "doesn't take reasoning" only when the retry without them succeeds; the panel then strikes through the selector.
- **UI:** the selector under the message box, and the chat and CSV-check settings.

### Permissions (`src/shared/permissions.ts`)
- **Kinds:** categorise, rules, organise (low risk); balances, deleteRules, accounts, import, memory (high risk). An op outside every kind always asks.
- **Modes:** ask (default), smart (low-risk kinds allowed), trust (all allowed), custom (per kind).
- **Always asks:** more than `BULK_LIMIT` (100) transactions in one change, except in trust; MCP requests while `mcpAlwaysAsk` is on (the default).
- **Where:** `needsApproval()` is called in the chat's confirm handler (`chat.ts`) and in the MCP bridge. An allowed change shows as an "auto" card in the chat; when that change then fails, the card says so (`failed`).
- **UI:** Settings → "What the assistant may do by itself".

### Memory (`src/core/memory.ts`, migration 11)
- **Storage:** the `memories` table in the encrypted database: text (max 300 characters), source (person or assistant), timestamps. At most 50 items; a duplicate (ignoring case) is not added twice.
- **Local only:** not in `SYNC_TABLES`; the sync snapshot that other computers join from is written with the table emptied (`writeTransfer(…, { leaveOut: ['memories'] })`). Exports and backups keep it, so moving computers or restoring brings it along.
- **Not over MCP:** `memory_remember` and `memory_forget` are left out of `mcpTools()`.
- **Sensitive text:** `looksSensitive()` (`src/shared/sensitive.ts`) refuses IBANs and runs of 13+ digits. The `memory.remember` schema refuses them too, so the person is never asked to approve one.
- **Prompt:** `memoryPrompt()` adds the items, with their ids and how to use the tools, to the chat's system prompt. When memory is off, neither the items nor the tools are sent. The CSV Check gets the items as `personNotes`.
- **Permission:** the `memory` kind, high risk, so it asks in "smart" too.
- **UI:** Settings → "What the assistant remembers": a switch, the list (change, forget), add by hand, and "Forget everything".

### To look at
- `looksSensitive` can refuse an uppercase phrase that looks like an IBAN, and it can't catch a password written in words; the system prompt also tells the model not to save those.
- Memory items are sent with every chat message while memory is on; the Settings text says so.
- `between_tools` for Sonnet 5.5 is cast in `claude.ts` because the SDK types may not list it yet.

## 7. Updates from the app and the welcome window

### Updates (`src/main/update.ts`, `src/core/update.ts`)
- **Check:** `GET https://api.github.com/repos/Mistraloro/kasboek/releases/latest` with a generic user agent, 15 s after start and then hourly when the last check is over a day old, only while `prefs.updateCheck` is on (default on). Drafts and pre-releases are ignored; `newer()` compares the numeric parts.
- **Which file:** `installKind()` (Windows → msi, macOS → dmg, Linux → AppImage when `APPIMAGE` is set, else deb) and `pickAsset()` by the build's file names and the processor.
- **Integrity:** downloads only from `https://github.com/Mistraloro/kasboek/releases/download/`. The SHA-256 comes from the asset's `digest` in GitHub's API, else from a `SHA256SUMS.txt` asset (now written by the release job); without either, nothing is installed. The file streams to `<userData>/updates/<name>.partial` and is renamed only when the hash matches.
- **Install:** a backup first (`safety-backups/before-update-….kasboek`, when unlocked), and a `pending.json` note.
  - Windows: `install.cmd` waits for this process to exit, runs `msiexec /i … /qn /norestart /l*v install.log`, then starts `process.execPath` again.
  - AppImage: copies next to the current file, `chmod 755`, renames over it, starts it.
  - deb/dmg: `shell.openPath`; the person finishes.
  - On the next start, if the version is still older than the note, the update window says it didn't install; otherwise `updates/` is removed.
- **Development runs:** nothing is checked unless `KASBOEK_UPDATE_API` points at a stand-in server (ignored in packaged builds).
- **UI:** `components/Update.tsx` (top-bar button only while a newer release waits; window with the notes from the first heading to "Download", progress, install), Settings row (switch, "Check now", last result).

### Welcome window (`pages/Welcome.tsx`) and tour (`components/Tour.tsx`)
- Shown after unlocking on a computer where `prefs.welcomeDone` is false (new data, a join, or the first start after this update).
- Steps: an introduction; basics (language, theme, main currency, one of 8 number-and-date styles shown as examples (`FORMAT_PRESETS`, `matchingPreset` in `shared/format.ts`), and "Exchange rates from the ECB", on by default: at the end it sets `fxAutoUpdate` and runs `fx.updateEcb` once); safety (automatic backups, which asks for a folder, and auto-lock, plus a note on the recovery key); the AI provider (all presets but "custom") and key, or skip; Claude apps (the MCP switch, then "Add to Claude Desktop" / "Add to Claude Code" with their state, the same operations as Settings); the update switch, on by default.
- Claude Code's state is now absent, current or outdated (`codeEntryState` in `core/mcp-config.ts`): `claude mcp get kasboek` must name this installation's helper and data folder. Settings shows "Update" only when it is outdated, as for Claude Desktop (it used to show "Update" whenever Kasboek was added).
- It ends with "Show me around" or "Skip the tour". The tour puts a spotlight on each part (the 8 pages, the assistant, Settings, Lock; targets carry `data-tour`), opens the page it talks about, and closes with Escape or a click outside. Settings has "Show the tour".

### To look at
- The Windows path (silent MSI and restart) was not run here; only the AppImage path, the deb/dmg path and the "didn't install" note were run end to end. If `kasboek-mcp.exe` is in use by a Claude app during the MSI upgrade, Windows may hold that file until a restart.
- Without code signing, the update is only as trustworthy as the GitHub account that publishes releases.
- Fixed in the review: the Windows install script switches to UTF-8 (`chcp 65001`) so user folders with accents work; a failing AppImage replace no longer leaves the window on "Installing…"; the automatic check waits until the welcome window is done.
