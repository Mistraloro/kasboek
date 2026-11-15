# Kasboek: changes since build 12 (a299a7d), for review

**What this covers:**
- **Range:** branch `ccr-0f0084e8-2jcj1g`, commits `02cd432` to `824f4f3`. That is 45 files, about 2,750 lines added and 310 removed.
- **Build:** CI run 14 (`824f4f3`) is green on Windows, macOS and Linux.
- **Tests:** 87 vitest tests pass, plus the Go helper tests. Typecheck, lint and the i18n check are clean.

**Testing done:**
- **Not tested** against the real Mistral or Anthropic APIs. The CSV Check was tested end to end in the Electron app with a fake OpenAI-compatible server, on a 752-row Hello bank! export.

**Context the reviewer needs:**
- **Stack:** Electron + TypeScript.
- **Layout:**
  - `src/core`: logic, with no Electron;
  - `src/main`: the Electron main process (assistant, MCP bridge, IPC);
  - `src/renderer`: the React UI;
  - `src/shared`: the contract (zod), types and formats;
  - `tools/kasboek-mcp`: the Go MCP helper.
- **Rule:** every change that writes data goes through an op in `src/core/ops.ts` and `src/main/ipc.ts`. Assistant and MCP changes wait for the person to approve them.
- **Earlier decisions to respect:**
  - Bank-text clean-up is done by the AI, not by per-bank code.
  - Main-process logs stay in English only.
  - No Excel importer.

---

## 1. Assistant prompts and replies

**`02cd432`: example prompts**
- The Keytrade/CSV example was removed: it named one bank, and the chat can't take files.
- New examples in all 8 locales, and in `scripts/regional-locales.py`.

**`a1d28ae`: replies that hit the length limit**
- `src/main/assistant/chat.ts`: OpenAI-compatible providers get `maxTokens` 32000 instead of 8192.
- `openai.chat`: on a 400/422 that mentions tokens, it retries once with 8192.
- `src/core/assistant-loop.ts`: on `max_tokens`, the loop no longer ends the turn.
  - A partial tool call is dropped, and any text written so far is kept.
  - A "continue in smaller steps" note is appended by `nudge()`. It is merged into the last user message when that one ends with tool results, so roles keep alternating.
  - This happens at most twice (`MAX_CONTINUES = 2`).
- **System prompt:** prefer `rules_create` for repeating payees; at most 200 ids per call; keep reasoning short.
- **Tests:** `tests/assistant-loop.test.ts`.

## 2. CSV Check (`e097198`, `9d81625`)

### 2.1 Names and descriptions
- **Plan per group:** `{group, categoryId, name, description}` (see `src/core/assist-plan.ts`). `applyPlan` in `src/main/assistant/csv.ts` writes `counterpartyName` and `description` overrides on every ready row of the group.
- **Duplicate detection stays on the raw text:**
  - `src/core/import.ts` `buildRows` computes the fingerprint from the raw bank text (`c.*`, with merged date and amount).
  - `commit` passes that fingerprint to `insertTransaction` (`NewTx.fingerprint`).
  - So a cleaned-up name still matches on re-import.
- **Rules:** they match the cleaned text or the raw text.

### 2.2 Already-imported rows and older transactions
- **Why Check seemed to do nothing:** re-importing a known file made every row `duplicate`, and Check skipped those silently.
- **Grouping:** `rowGroups(rows, existing)` now groups the import's ready rows together with the account's uncategorised transactions already in the database (`existingUncategorised`, at most 5000).
- **Context sent to the model:** the group line format is `group | new rows | already in Kasboek | in/out | example amountCents | total amountCents | category now | counterparty | bank text`.
- **Categories for older transactions:** for the database rows, `applyPlan` builds `existing` proposals only. Nothing is written until the person accepts (see 2.5).
- **Nothing to check:** if there are no groups, no problems and no possible duplicates, Check throws `assistant.nothing_to_check`.

### 2.3 Suggested rules (`checkRules` in `csv.ts`)
- **Plan field:** `rules: {group, field, match, pattern, categoryId}[]`. `parsePlan` defaults `match` to `contains` and accepts plans without `rules`.
- **A rule is dropped, with a reason in `summary.dropped`, if:**
  - the pattern is under 4 characters;
  - it doesn't match every row and every existing transaction of its group. Group membership is taken from the groups as sent, by row index, because names may have changed since;
  - it matches more than 5 other groups ("too general"; in testing this caught "BANKREFERENTIE");
  - it would catch rows or uncategorised transactions of other groups whose planned category differs (null counts as different);
  - categorised transactions in another category outnumber `max(1, agreeing / 5)`.
- **Also skipped silently:** duplicates of existing rules.

### 2.4 Duplicate detection (`buildRows` in `import.ts`)
1. **Bank reference:** a reference that is unique within the file and already exists for the account means `duplicate`. A reference repeated in the file (a statement number) is ignored.
2. **Exact fingerprint:** the n-th copy is a duplicate only if the account already has n of them.
3. **New status `possible_duplicate`:**
   - Conditions: same amount, booking date within ±3 days, token-overlap similarity of at least 0.6 (`similarity()`), a different fingerprint, and no conflicting bank reference.
   - Not imported unless the person includes it.
   - The row gets `match` (the existing transaction) and the issue `possible_duplicate`.
- **Matching once:** each existing transaction is matched by at most one row (the `claimed` set).
- **Stats:** `possibleDuplicates`, `fileFrom` and `fileTo` were added.
- **Indexes:** migration 6 adds `idx_tx_bank_reference` and `idx_tx_account_amount`.

### 2.5 Check state, undo and apply
- **Session state:** `CheckState` holds a snapshot of the overrides and mapping from before the check, plus the row indices each part changed (`categories`, `names`, `fixes`) and the transaction ids per proposal.
- **`import.checkUndo {part}`:** restores only that part's fields (`PART_FIELDS`). `all` restores the whole snapshot.
- **`import.checkApply {rules[], existing[]}`:** in one database transaction, it categorises the ticked existing groups, then creates the ticked rules with `applyToExisting` (an existing duplicate rule is ignored). This is the person's approval, given by clicking in the UI; the assistant can't call it (`assistant: false`).
- **UI:** `CheckSummaryCard` in `src/renderer/src/pages/Import.tsx`.
  - It lists what Check did, with an Undo per part.
  - It shows checklists for existing categorisations and rules, an "Apply selected" button, and the dropped suggestions.
- **Fully imported file (E1):** a banner, Discard as the main button, the Check button relabelled "Categorise with …", and the period and amount line hidden.

### 2.6 Context and privacy
- **IBANs:** masked to `CC…1234` in raw cells, group texts and matches (`maskIban`). The account's own IBAN is no longer sent.
- **Flagged rows:** up to 150, spread over the whole file (`spread`). Exact duplicates are no longer sent.
- **CSV `json()` call:** asks for 32000 output tokens. The order is strict `json_schema`, then `json_object`, then 8192 tokens if the error mentions tokens.

## 3. Rules engine (`src/core/finance.ts`, migration 6)
- **New columns:** `rules.match` (`contains | word | starts`) and `rules.priority`. Both are in the sync spec (`sync-schema.ts`).
- **Matching:**
  - `textMatches` folds case and accents.
  - `word` mode uses a Unicode letter/number boundary regex, cached.
  - A `contains` pattern under 4 characters is stored as `word` (`effectiveMatch`).
- **Order:** `priority DESC`, then counterparty rules first, then longer patterns, then id.
- **New functions:** `previewRule`, `updateRule`, `reorderRules`.
- **Speed:** `insertTransaction(db, t, rules?)`, so a commit reads the rules once.
- **New ops:**
  - `rules.preview` (assistant: yes);
  - `rules.update` (assistant: yes, approval needed);
  - `rules.reorder` (UI only);
  - `rules.delete` is now open to the assistant, with approval.
- **New op `transactions.edit`:** for the assistant, with approval. It changes only category, notes, description and counterparty.
- **UI (`Budgets.tsx` RulesModal):** a match selector, a live preview, and up/down ordering.

## 4. Assistant tools and the MCP bridge
- **`compactResult(op, data, input)`:**
  - `fitJson` always returns valid JSON. Lists keep as many whole items as fit in 60k characters (binary search) and add `truncated`, `shown`, `of` and `nextOffset`.
  - Items of `transactions.list` are slimmed (`slimItem`).
  - Import previews include the `check` summary.
- **Approval texts (`describeChange`):**
  - `transactions.categorize` now shows the count, total, date range and top payees;
  - new texts for `transactions.edit`, `rules.update`, `rules.delete` and `balances.set`;
  - `rules.create` shows how many transactions it reaches.
- **Bridge (`src/main/mcp/bridge.ts`):**
  - every request gets a reply, also when `handle` throws;
  - no writing to a socket that is already closed;
  - approvals wait 10 minutes and then broadcast `mcp.expired`;
  - listen errors are kept (`mcpBridgeError`), retried every 30 seconds, and shown in Settings → Assistant (`McpSetupStatus.bridgeError`).
- **Pipe name (`channel.ts`):** random on each start and published in the discovery file. The Go helper already reads the path from that file.
- **UI (`McpRequests.tsx`):** an expired state, a count of waiting requests, and "Approve all N" for queued requests of the same op.

## 5. OpenAI-compatible providers (`src/main/assistant/openai.ts`)
- **`request()`:**
  - a timeout (10 minutes for chat and json, 30 seconds for `/models`) combined with the caller's signal;
  - two retries on network errors and on 429/500/502/503/504, before any of the body is read;
  - honours `Retry-After` (up to 20 seconds), else waits 1 s, then 3 s.
- **`toOpenAi`:** inserts an assistant `'…'` message between a `tool` message and a following `user` message (Mistral rejects user after tool).
- **`chat.ts`:** a turn that stops after tool results gets an assistant message, "(Stopped before finishing.)".
- **`chatModels`:**
  - drops entries with `deprecation`, and entries whose `capabilities` lack `completion_chat` or `function_calling`;
  - entries with the same set of names count as one model, and the `-latest` alias is preferred.
- **`ipc.ts` `assistant.setKey`:** the key is checked against the address of its own provider. The stored `aiBaseUrl` counts only when that provider is the active one.
- **Settings:** the CSV model field placeholder says "Same as the chat model (…)".

## 6. Bank balance (`2c48f3f`)
- **Problem:** the opening balance was always 0 (no UI asked for it), so balances were wrong after an import.
- **Storage:** checkpoints are rows in the existing `valuations` table, meaning the balance at the end of that day. They already sync.
- **`src/core/balance.ts`:**
  - `balanceOn(date)`:
    - from the latest checkpoint on or before the date, plus the transactions since;
    - else back from the first checkpoint after it;
    - else the opening balance plus all transactions.
  - `currentBalance`: the last checkpoint plus everything after it.
  - `setBankBalance`: refuses future dates. Before saving, it computes what Kasboek expected from the other checkpoints, and returns `expectedCents` and `differenceCents`. The difference is null for investment accounts, where changes are gains.
  - `listBankBalances`: newest first, each balance compared with the one before it.
  - Transactions in another currency are converted with `fx()` at their booking date.
- **Integration:**
  - `finance.accountBalances` uses `currentBalance` for accounts that have checkpoints;
  - `wealth.valueOn` works back from the first checkpoint for non-investment accounts;
  - `accounts.list` adds `lastBankBalance {date, balanceCents, differenceCents}`;
  - `accounts.create` accepts `bankBalance {date, cents}`;
  - new ops `balances.list` and `balances.set` (assistant, with approval).
- **CSV:**
  - new mapping column `balance`, with synonyms such as saldo, solde, balance and kontostand;
  - `CleanRow.balanceCents`;
  - `fileBalance()` takes the balance after the last transaction of the last day, for files in either date order;
  - `commit` records it (note "From the CSV"; investment accounts skipped).
  - `commit` now returns `ImportCommitResult {lastDate, balanceOnLastDate, bankBalance, askBalance}`.
  - The assistant's mapping schema has `balance`. `parsePlan` fills missing column keys with null.
- **UI (`src/renderer/src/components/BankBalance.tsx`):**
  - `BankBalanceModal`, opened from Settings → Accounts and the Net worth page for non-investment accounts;
  - `ImportBalanceCheck` in the banner after an import. It asks when the account has no checkpoint; otherwise it shows Kasboek's balance and a "Compare" link;
  - a balance field in the new-account form;
  - a warning in the account row when the latest checkpoint doesn't match.

## 7. Packaging and CI
- **`electron-builder.yml`:** each platform's `files` used to contain only an exclusion. electron-builder then fell back to `**/*`, so the app package held `src/`, `tests/`, `tools/`, `scripts/` and old `release/` builds. The platform sections now list `out/**`, `resources/**` and `package.json` again.
- **`.github/workflows/build.yml`:** a new step lists `app.asar` and fails if it holds sources, tests, tools, scripts, releases or `.ts` files outside node_modules. In `824f4f3`, `|| true` was added after the grep, because with pipefail a grep that found nothing failed the step.

## 8. Translations
- **New keys** in en, nl, fr, de, es and pt-PT for `mcp.*`, `budgets.match*` and `budgets.reach*`, `import.check.*`, `import.status.possible_duplicate`, and `balance.*`.
- **es-419 and pt-BR** are regenerated by `scripts/regional-locales.py`, which has new rules for "añadirlo" and "também pode".
- **Check:** `scripts/check-i18n.mjs` reports no problems.

## 9. Tests added
- **`tests/review-fixes.test.ts`:**
  - rule matching, ordering, preview and update;
  - duplicates by reference, possible duplicates, identical coffees, and a repeated statement number;
  - Check undo and apply, groups with existing transactions, plan parsing;
  - `fitJson`, the `toOpenAi` role order, `chatModels`, retry on 503, `maskIban`.
- **`tests/balance.test.ts`:**
  - balances before and after a checkpoint, and with older history imported later;
  - the mismatch and its fix; a future date; investments;
  - net worth history; `fileBalance` order; CSV balance on import; `askBalance`.

## 10. Known limits and what to look at
- **Duplicate rows on screen:** they show their own category, not the category of the matching existing transaction.
- **Old imports keep long bank texts:** Check renames only rows it imports. Undoing the import and importing again fixes that.
- **Not built (decided):** a separate `raw_description` column and a deterministic per-bank cleaner.
- **Worth a closer look:**
  - the thresholds in `checkRules`;
  - the speed of `buildRows` on large imports: it runs up to 3 prepared queries per row on every preview;
  - `balances.set` and the existing `valuations.set` now share one table, with different meanings depending on the account kind.
