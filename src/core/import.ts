/**
 * CSV import sessions. Nothing is written until commit; the person (or the assistant, with
 * confirmation) can change the mapping, skip rows and set categories first.
 */
import { randomUUID } from 'node:crypto'
import type { CheckPart, CheckSummary, ImportBatch, ImportCommitResult, ImportPreview, ImportRow } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { categorizeTransactions, createRule, insertTransaction, listRules, matchRule } from './finance'
import { groupKey } from './assist-plan'
import { findTransfers, pairTransfers } from './transfers'
import { balanceOn, setBankBalance } from './balance'
import { fingerprint } from './fingerprint'
import { autoMap, detectLayout, headerSignature, mappingSchema, type CsvMapping } from './csv/mapping'
import { normalizeRows, realReference, type CleanRow } from './csv/normalize'
import { decode, detectDelimiter, parseCsv } from './csv/read'

export interface RowOverride {
  decided?: 'include' | 'skip' | null
  categoryId?: number | null
  categorySource?: ImportRow['categorySource']
  bookingDate?: string
  amountCents?: number
  description?: string
  counterpartyName?: string | null
  note?: string | null
}

interface Session {
  id: string
  fileName: string
  accountId: number
  encoding: string
  rows: string[][]
  mapping: CsvMapping | null
  mappingSource: ImportPreview['mappingSource']
  layout: string | null
  overrides: Map<number, RowOverride>
  notes: string[]
  check: CheckState | null
  /** Readable names learned from earlier imports, by the bank's own text (read once per import). */
  learned?: Map<string, { name: string | null; description: string }>
}

/** What the last Check changed (so each part can be undone) and what it proposes outside the import. */
export interface CheckState {
  summary: Omit<CheckSummary, 'categorised' | 'renamed' | 'fixed'>
  /** Overrides and mapping from before the check. */
  before: { overrides: Map<number, RowOverride>; mapping: CsvMapping | null; mappingSource: ImportPreview['mappingSource'] }
  /** Rows each part changed. */
  parts: { categories: number[]; names: number[]; fixes: number[] }
  /** Proposed categorisations of transactions already in Kasboek: transaction ids per proposal id. */
  existingIds: Map<number, number[]>
}

const PART_FIELDS: Record<Exclude<CheckPart, 'all'>, (keyof RowOverride)[]> = {
  categories: ['categoryId', 'categorySource'],
  names: ['counterpartyName', 'description'],
  fixes: ['decided', 'bookingDate', 'amountCents', 'description', 'note']
}

const sessions = new Map<string, Session>()
const MAX_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 50_000

/** Called on lock: import data never outlives the login. */
export function clearImportSessions(): void {
  sessions.clear()
}

function session(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new AppError('import.expired', 'This import is no longer open. Choose the file again.')
  return s
}

export function latestSession(): string | null {
  return [...sessions.keys()].at(-1) ?? null
}

export function analyze(db: Db, input: { fileName: string; bytes: Uint8Array; accountId: number }): ImportPreview {
  if (input.bytes.length > MAX_BYTES) throw new AppError('import.too_big', 'This file is larger than 10 MB.')
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.accountId)) throw new AppError('accounts.not_found', 'Choose an account first.')
  const { text, encoding } = decode(input.bytes)
  const delimiter = detectDelimiter(text) as CsvMapping['delimiter']
  const rows = parseCsv(text, delimiter)
  if (rows.length < 2) throw new AppError('import.empty', 'This file has no rows to import.')
  if (rows.length > MAX_ROWS) throw new AppError('import.too_many', 'This file has more than 50,000 rows.')

  let mapping = autoMap(rows, delimiter)
  let source: ImportPreview['mappingSource'] = mapping ? 'detected' : 'none'
  // A mapping saved from an earlier import with the same header row wins.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const saved = db.prepare('SELECT mapping_json FROM csv_profiles WHERE header_signature = ?').get(headerSignature(rows[i]!, delimiter)) as { mapping_json: string } | undefined
    if (saved) {
      const parsed = mappingSchema.safeParse(JSON.parse(saved.mapping_json))
      if (parsed.success) {
        mapping = parsed.data
        source = 'saved'
      }
      break
    }
  }
  for (const s of sessions.values()) if (s.accountId === input.accountId) sessions.delete(s.id)
  const s: Session = {
    id: randomUUID(),
    fileName: input.fileName,
    accountId: input.accountId,
    encoding,
    rows,
    mapping,
    mappingSource: source,
    layout: detectLayout(rows[mapping?.headerRow ?? 0] ?? []),
    overrides: new Map(),
    notes: [],
    check: null
  }
  sessions.set(s.id, s)
  return preview(db, s.id)
}

export function remap(db: Db, id: string, mapping: unknown, source: ImportPreview['mappingSource'] = 'manual'): ImportPreview {
  const s = session(id)
  const parsed = mappingSchema.parse(mapping)
  const width = Math.max(...s.rows.map((r) => r.length))
  const cols = parsed.columns
  const all = [cols.bookingDate, cols.valueDate, cols.amount, cols.debit, cols.credit, cols.currency, cols.counterpartyName, cols.counterpartyIban, cols.communication, cols.bankReference, cols.status, ...cols.description]
  if (all.some((c) => c !== undefined && c >= width) || parsed.headerRow >= s.rows.length - 1) throw new AppError('import.bad_mapping', 'That column doesn’t exist in this file.')
  s.mapping = parsed
  s.mappingSource = source
  s.layout = detectLayout(s.rows[parsed.headerRow] ?? []) ?? s.layout
  return preview(db, id)
}

export function updateRows(db: Db, id: string, changes: ({ index: number } & RowOverride)[]): ImportPreview {
  const s = session(id)
  for (const { index, ...change } of changes) {
    const prev = s.overrides.get(index) ?? {}
    s.overrides.set(index, { ...prev, ...change, ...(change.categoryId !== undefined && !change.categorySource ? { categorySource: 'user' } : {}) })
  }
  return preview(db, id)
}

export function addNotes(id: string, notes: string[]): void {
  session(id).notes = notes
}

/** Remembers the state before a check, so its changes can be undone. Call before changing anything. */
export function snapshot(id: string): CheckState['before'] {
  const s = session(id)
  return { overrides: new Map([...s.overrides].map(([k, v]) => [k, { ...v }])), mapping: s.mapping, mappingSource: s.mappingSource }
}

export function setCheck(id: string, check: CheckState | null): void {
  session(id).check = check
}

export function getCheck(id: string): CheckState | null {
  return session(id).check
}

/**
 * Applies the Check proposals the person ticked: categorises transactions already in Kasboek and
 * creates rules (which also categorise uncategorised transactions and this import's rows).
 */
export function applyCheckProposals(db: Db, id: string, pick: { rules: number[]; existing: number[] }): { preview: ImportPreview; rules: number; categorised: number; skipped: number } {
  const s = session(id)
  const c = s.check
  if (!c) throw new AppError('import.no_check', 'There is nothing to apply: check the file first.')
  let rules = 0
  let categorised = 0
  let skipped = 0
  db.transaction(() => {
    for (const p of c.summary.existing.filter((e) => pick.existing.includes(e.id))) {
      const ids = c.existingIds.get(p.id) ?? []
      // Only those still without a category: one set since the check (by hand, a rule or the
      // assistant) is left as it is.
      if (ids.length) {
        const n = categorizeTransactions(db, ids, p.categoryId, { onlyUncategorised: true }).updated
        categorised += n
        skipped += ids.length - n
      }
    }
    for (const r of c.summary.rules.filter((x) => pick.rules.includes(x.id))) {
      try {
        categorised += createRule(db, { field: r.field, pattern: r.pattern, match: r.match, categoryId: r.categoryId, applyToExisting: true }).applied
        rules++
      } catch (err) {
        // A rule for this text was made in the meantime: nothing to add.
        if (!(err instanceof AppError && err.code === 'rules.duplicate')) throw err
      }
    }
  })()
  c.summary = {
    ...c.summary,
    rules: c.summary.rules.filter((x) => !pick.rules.includes(x.id)),
    existing: c.summary.existing.filter((x) => !pick.existing.includes(x.id)),
    applied: { rules: (c.summary.applied?.rules ?? 0) + rules, categorised: (c.summary.applied?.categorised ?? 0) + categorised }
  }
  return { preview: preview(db, id), rules, categorised, skipped }
}

/** Undoes one part of the last check (or all of it), putting back what the rows had before. */
export function undoCheck(db: Db, id: string, part: CheckPart): ImportPreview {
  const s = session(id)
  const c = s.check
  if (!c) return preview(db, id)
  if (part === 'all') {
    s.overrides = new Map([...c.before.overrides].map(([k, v]) => [k, { ...v }]))
    s.mapping = c.before.mapping
    s.mappingSource = c.before.mappingSource
    s.check = null
    s.notes = []
    return preview(db, id)
  }
  for (const index of c.parts[part]) {
    const now = { ...(s.overrides.get(index) ?? {}) }
    const was = c.before.overrides.get(index) ?? {}
    for (const f of PART_FIELDS[part]) {
      if (was[f] === undefined) delete now[f]
      else (now as Record<string, unknown>)[f] = was[f]
    }
    s.overrides.set(index, now)
  }
  c.parts[part] = []
  return preview(db, id)
}

/** Words of a bank text, for comparing two texts that may be worded a little differently. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2 && !/^\d+$/.test(w))
  )
}

/** Share of the shorter text's words that also appear in the other. */
export function similarity(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (!x.size || !y.size) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size)
}

const POSSIBLE_DAYS = 3
const POSSIBLE_SIMILARITY = 0.6

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

interface Existing {
  id: number
  booking_date: string
  counterparty_name: string | null
  description: string
  bank_counterparty: string | null
  bank_description: string | null
  bank_reference: string | null
  fingerprint: string | null
}

/**
 * Names and descriptions tidied in earlier imports, keyed by the bank's own text: a new row with
 * the same bank text gets the same readable text, so rules made on readable names keep working.
 */
function learnedNames(db: Db): Map<string, { name: string | null; description: string }> {
  const rows = db
    .prepare(
      `SELECT counterparty_name, description, bank_counterparty, bank_description, counterparty_iban, communication, amount_cents FROM transactions
       WHERE bank_description IS NOT NULL AND (coalesce(counterparty_name, '') <> coalesce(bank_counterparty, '') OR description <> bank_description)
       ORDER BY booking_date, id`
    )
    .all() as { counterparty_name: string | null; description: string; bank_counterparty: string | null; bank_description: string; counterparty_iban: string | null; communication: string | null; amount_cents: number }[]
  const map = new Map<string, { name: string | null; description: string }>()
  // The latest one wins, so a name corrected later is the one used.
  for (const r of rows)
    map.set(groupKey({ counterpartyName: r.bank_counterparty, description: r.bank_description, amountCents: r.amount_cents, communication: r.communication, counterpartyIban: r.counterparty_iban }), {
      name: r.counterparty_name,
      description: r.description
    })
  return map
}

function buildRows(db: Db, s: Session): { clean: CleanRow; raw: CleanRow; row: ImportRow; fingerprint: string | null }[] {
  if (!s.mapping) return []
  const currency = (db.prepare('SELECT currency FROM accounts WHERE id = ?').get(s.accountId) as { currency: string }).currency
  const clean = normalizeRows(s.rows, s.mapping, currency)
  const rules = listRules(db)
  const cols = 'id, booking_date, counterparty_name, description, bank_counterparty, bank_description, bank_reference, fingerprint'
  const byFingerprint = db.prepare(`SELECT ${cols} FROM transactions WHERE account_id = ? AND fingerprint = ? ORDER BY id`)
  const byReference = db.prepare(`SELECT ${cols} FROM transactions WHERE account_id = ? AND bank_reference = ? ORDER BY id`)
  const nearby = db.prepare(`SELECT ${cols} FROM transactions WHERE account_id = ? AND amount_cents = ? AND booking_date BETWEEN ? AND ? ORDER BY id`)
  // A bank reference identifies one transaction only if it is unique in this file (some banks
  // repeat a statement number on every line).
  const refCount = new Map<string, number>()
  for (const c of clean) if (c.bankReference?.trim()) refCount.set(c.bankReference.trim(), (refCount.get(c.bankReference.trim()) ?? 0) + 1)
  const seen = new Map<string, number>()
  // Transactions already matched by an earlier row: each one is matched at most once.
  const claimed = new Set<number>()
  s.learned ??= learnedNames(db)
  const learned = s.learned
  const results = clean.map((c) => {
    const o = s.overrides.get(c.index) ?? {}
    const known = learned.size ? learned.get(groupKey(c)) : undefined
    const merged: CleanRow = {
      ...c,
      bookingDate: o.bookingDate ?? c.bookingDate,
      amountCents: o.amountCents ?? c.amountCents,
      description: o.description ?? known?.description ?? c.description,
      counterpartyName: o.counterpartyName !== undefined ? o.counterpartyName : known ? known.name : c.counterpartyName
    }
    // Duplicates are recognised on the bank's own text, so a cleaned-up name or description still
    // matches the same transaction imported earlier (only corrected dates and amounts count).
    let fp: string | null = null
    let match: Existing | null = null
    const issues = c.issues.filter((i) => !(i === 'date_invalid' && o.bookingDate) && !(i.startsWith('amount') && o.amountCents))
    let status: ImportRow['status'] = 'ready'
    if (issues.some((i) => i !== 'currency_other')) status = issues.includes('status_refused') ? 'skipped' : 'problem'
    else if (merged.bookingDate && merged.amountCents !== null) {
      fp = fingerprint({ accountId: s.accountId, bookingDate: merged.bookingDate, amountCents: merged.amountCents, counterpartyName: c.counterpartyName, description: c.description, bankReference: c.bankReference })
      const ref = c.bankReference?.trim() || null
      // 1. The same bank reference: the same transaction, whatever the text says now.
      if (ref && refCount.get(ref) === 1) {
        match = (byReference.all(s.accountId, ref) as Existing[]).find((e) => !claimed.has(e.id)) ?? null
      }
      // 2. The same date, amount and text. The n-th copy counts as a duplicate only if the account
      // already has n of them (two identical coffees on one day are both real).
      if (!match) {
        const nth = (seen.get(fp) ?? 0) + 1
        seen.set(fp, nth)
        const same = byFingerprint.all(s.accountId, fp) as Existing[]
        if (same.length >= nth) match = same.find((e) => !claimed.has(e.id)) ?? same[nth - 1] ?? null
      }
      // 2b. Imported earlier while still pending, before the bank gave it a reference: the same
      // transaction without the reference.
      if (!match && ref) {
        const pendingFp = fingerprint({ accountId: s.accountId, bookingDate: merged.bookingDate, amountCents: merged.amountCents, counterpartyName: c.counterpartyName, description: c.description, bankReference: null })
        match = (byFingerprint.all(s.accountId, pendingFp) as Existing[]).find((e) => !claimed.has(e.id) && !e.bank_reference) ?? null
      }
      if (match) status = 'duplicate'
      else {
        // 3. Possibly the same: same amount a few days apart with similar text (the bank reworded
        // it, or moved the date). The person (or Check) decides.
        const text = `${c.counterpartyName ?? ''} ${c.description}`
        const candidates = nearby.all(s.accountId, merged.amountCents, shiftDate(merged.bookingDate, -POSSIBLE_DAYS), shiftDate(merged.bookingDate, POSSIBLE_DAYS)) as Existing[]
        match =
          candidates.find(
            (e) =>
              !claimed.has(e.id) &&
              e.fingerprint !== fp &&
              // A different reference means a different payment, but only when it is a real one.
              !(ref && realReference(e.bank_reference) && e.bank_reference!.trim() !== ref) &&
              // Compared with the bank's own text, as the new row's text is too.
              similarity(text, `${e.bank_counterparty ?? e.counterparty_name ?? ''} ${e.bank_description ?? e.description}`) >= POSSIBLE_SIMILARITY
          ) ?? null
        if (match) status = 'possible_duplicate'
      }
      if (match) claimed.add(match.id)
    }
    if (o.decided === 'skip') status = 'skipped'
    if (o.decided === 'include' && status !== 'problem') status = 'ready'
    // Rules match the cleaned-up text or the bank's own.
    const rule = o.categoryId === undefined ? (matchRule(db, merged, rules) ?? matchRule(db, c, rules)) : undefined
    return {
      clean: merged,
      raw: c,
      fingerprint: fp,
      row: {
        index: c.index,
        line: c.line,
        bookingDate: merged.bookingDate,
        amountCents: merged.amountCents,
        description: merged.description,
        counterpartyName: merged.counterpartyName,
        counterpartyIban: merged.counterpartyIban,
        communication: merged.communication,
        categoryId: o.categoryId !== undefined ? o.categoryId : (rule?.categoryId ?? null),
        categorySource: o.categoryId !== undefined ? (o.categorySource ?? 'user') : rule ? 'rule' : null,
        issues: status === 'possible_duplicate' ? [...issues, 'possible_duplicate'] : issues,
        status,
        decided: o.decided ?? null,
        note: o.note ?? null,
        match: match ? { id: match.id, bookingDate: match.booking_date, counterpartyName: match.counterparty_name, description: match.description } : null
      } satisfies ImportRow
    }
  })
  return results
}

/** The rows with the bank's own text next to them (for checking rules against future imports). */
export function rowsWithBankText(db: Db, id: string): { row: ImportRow; raw: { counterpartyName: string | null; description: string; counterpartyIban: string | null } }[] {
  return buildRows(db, session(id)).map((b) => ({ row: b.row, raw: { counterpartyName: b.raw.counterpartyName, description: b.raw.description, counterpartyIban: b.raw.counterpartyIban } }))
}

export function preview(db: Db, id: string): ImportPreview {
  const s = session(id)
  const rows = buildRows(db, s).map((r) => r.row)
  const ready = rows.filter((r) => r.status === 'ready')
  const dates = ready.map((r) => r.bookingDate!).sort()
  const fileDates = rows.flatMap((r) => (r.bookingDate ? [r.bookingDate] : [])).sort()
  const headerRow = s.mapping?.headerRow ?? 0
  const account = db.prepare('SELECT name, currency FROM accounts WHERE id = ?').get(s.accountId) as { name: string; currency: string }
  return {
    sessionId: s.id,
    fileName: s.fileName,
    accountId: s.accountId,
    accountName: account.name,
    currency: account.currency,
    layout: s.layout,
    encoding: s.encoding,
    mappingSource: s.mappingSource,
    headers: s.rows[headerRow] ?? [],
    sample: s.rows.slice(headerRow + 1, headerRow + 6),
    mapping: s.mapping,
    rows,
    stats: {
      total: rows.length,
      ready: ready.length,
      duplicates: rows.filter((r) => r.status === 'duplicate').length,
      possibleDuplicates: rows.filter((r) => r.status === 'possible_duplicate').length,
      problems: rows.filter((r) => r.status === 'problem').length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      inCents: ready.reduce((t, r) => t + Math.max(0, r.amountCents ?? 0), 0),
      outCents: ready.reduce((t, r) => t - Math.min(0, r.amountCents ?? 0), 0),
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      fileFrom: fileDates[0] ?? null,
      fileTo: fileDates.at(-1) ?? null
    },
    notes: s.notes,
    check: s.check ? checkSummary(s.check) : null
  }
}

function checkSummary(c: CheckState): CheckSummary {
  return { ...c.summary, categorised: c.parts.categories.length, renamed: c.parts.names.length, fixed: c.parts.fixes.length }
}

/** Raw rows for the assistant: header plus a window of data rows. */
export function rawWindow(id: string, from = 0, count = 40): { headerRow: number; header: string[]; rows: { index: number; cells: string[] }[]; totalRows: number; preamble: string[][] } {
  const s = session(id)
  const hr = s.mapping?.headerRow ?? 0
  const data = s.rows.slice(hr + 1)
  return {
    headerRow: hr,
    header: s.rows[hr] ?? [],
    rows: data.slice(from, from + count).map((cells, i) => ({ index: from + i, cells })),
    totalRows: data.length,
    preamble: s.rows.slice(0, hr)
  }
}

export function commit(db: Db, id: string, saveProfile: boolean): ImportCommitResult {
  const s = session(id)
  if (!s.mapping) throw new AppError('import.no_mapping', 'Choose which columns hold the date and amount first.')
  const built = buildRows(db, s)
  const ready = built.filter((b) => b.row.status === 'ready')
  if (!ready.length) throw new AppError('import.nothing', 'There are no rows ready to import.')
  const currency = (db.prepare('SELECT currency FROM accounts WHERE id = ?').get(s.accountId) as { currency: string }).currency
  let batchId = 0
  const rules = listRules(db)
  db.transaction(() => {
    batchId = Number(
      db.prepare("INSERT INTO import_batches (account_id, file_name, csv_profile, row_count, status, committed_at) VALUES (?, ?, ?, ?, 'committed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        .run(s.accountId, s.fileName, s.layout, ready.length).lastInsertRowid
    )
    for (const { clean, raw, row, fingerprint: fp } of ready) {
      insertTransaction(db, {
        accountId: s.accountId,
        bookingDate: row.bookingDate!,
        valueDate: clean.valueDate,
        amountCents: row.amountCents!,
        currency: clean.currency && /^[A-Z]{3}$/.test(clean.currency) ? clean.currency : currency,
        description: row.description || '(no description)',
        counterpartyName: row.counterpartyName,
        counterpartyIban: row.counterpartyIban,
        communication: row.communication,
        categoryId: row.categoryId,
        bankReference: clean.bankReference,
        importBatchId: batchId,
        fingerprint: fp ?? undefined,
        bankCounterparty: raw.counterpartyName,
        bankDescription: raw.description || row.description || '(no description)'
      }, rules)
    }
    if (saveProfile) {
      const header = s.rows[s.mapping!.headerRow] ?? []
      db.prepare(
        `INSERT INTO csv_profiles (name, bank, header_signature, mapping_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(header_signature) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).run(s.layout ?? s.fileName, s.layout, headerSignature(header, s.mapping!.delimiter), JSON.stringify(s.mapping))
    }
  })()
  sessions.delete(id)
  // Transfers to or from another own account that are sure (the account number matches) are
  // paired at once; others are only suggested.
  const ids = (db.prepare('SELECT id FROM transactions WHERE import_batch_id = ?').all(batchId) as { id: number }[]).map((r) => r.id)
  const found = ids.length ? findTransfers(db, { onlyIds: ids }) : []
  const transfersPaired = pairTransfers(db, found.filter((f) => f.confidence === 'iban')).paired
  const transfersSuggested = found.filter((f) => f.confidence === 'amount').length
  const dates = built.flatMap((b) => (b.row.bookingDate ? [b.row.bookingDate] : [])).sort()
  const lastDate = dates.at(-1) ?? null
  const kind = (db.prepare('SELECT kind FROM accounts WHERE id = ?').get(s.accountId) as { kind: string }).kind
  // A balance column: the balance after the last transaction of the file is what the bank showed
  // that day, so it is recorded (and compared with what Kasboek expected).
  let bankBalance: ImportCommitResult['bankBalance'] = null
  const fromFile = fileBalance(built.map((b) => b.raw))
  let balanceNote: string | null = null
  if (fromFile && kind !== 'investment') {
    try {
      bankBalance = setBankBalance(db, { accountId: s.accountId, date: fromFile.date, balanceCents: fromFile.cents, note: 'From the CSV' })
    } catch (err) {
      console.warn('[import] closing balance from the CSV not recorded:', err instanceof Error ? err.message : err)
      balanceNote = err instanceof Error ? err.message : 'The closing balance in the file could not be recorded.'
    }
  }
  const hasBalance = !!db.prepare('SELECT 1 FROM valuations WHERE account_id = ?').get(s.accountId)
  return {
    batchId,
    imported: ready.length,
    skipped: built.length - ready.length,
    lastDate,
    balanceOnLastDate: lastDate ? balanceOn(db, s.accountId, lastDate).cents : null,
    bankBalance,
    balanceNote,
    transfersPaired,
    transfersSuggested,
    askBalance: kind !== 'investment' && !hasBalance
  }
}

/** What committing the open import would do, for the approval text. */
export function commitSummary(db: Db, id: string): { rows: number; totalCents: number; from: string | null; to: string | null; accountName: string; currency: string; closing: { date: string; cents: number } | null } {
  const s = session(id)
  const built = buildRows(db, s)
  const ready = built.filter((b) => b.row.status === 'ready')
  const dates = ready.map((b) => b.row.bookingDate!).sort()
  const account = db.prepare('SELECT name, currency, kind FROM accounts WHERE id = ?').get(s.accountId) as { name: string; currency: string; kind: string }
  return {
    rows: ready.length,
    totalCents: ready.reduce((t, b) => t + (b.row.amountCents ?? 0), 0),
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    accountName: account.name,
    currency: account.currency,
    closing: account.kind === 'investment' ? null : fileBalance(built.map((b) => b.raw))
  }
}

/**
 * The balance at the end of the file's last day, from a balance column: the balance after that
 * day's last transaction (files list either the newest or the oldest first).
 */
export function fileBalance(rows: Pick<CleanRow, 'bookingDate' | 'balanceCents'>[]): { date: string; cents: number } | null {
  const dated = rows.filter((r): r is typeof r & { bookingDate: string } => !!r.bookingDate)
  if (!dated.some((r) => r.balanceCents !== null)) return null
  const newestFirst = dated.length > 1 && dated[0]!.bookingDate > dated.at(-1)!.bookingDate
  const last = dated.reduce((m, r) => (r.bookingDate > m ? r.bookingDate : m), '')
  const sameDay = dated.filter((r) => r.bookingDate === last && r.balanceCents !== null)
  const row = newestFirst ? sameDay[0] : sameDay.at(-1)
  return row ? { date: last, cents: row.balanceCents! } : null
}

export function discard(id: string): void {
  sessions.delete(id)
}

export function listBatches(db: Db): ImportBatch[] {
  return (
    db
      .prepare(
        `SELECT b.id, b.file_name, a.name AS account_name, b.row_count, b.committed_at,
           (SELECT count(*) FROM transactions t WHERE t.import_batch_id = b.id) AS remaining
         FROM import_batches b JOIN accounts a ON a.id = b.account_id WHERE b.status = 'committed' ORDER BY b.id DESC LIMIT 20`
      )
      .all() as { id: number; file_name: string; account_name: string; row_count: number; committed_at: string; remaining: number }[]
  ).map((r) => ({ id: r.id, fileName: r.file_name, accountName: r.account_name, rowCount: r.row_count, committedAt: r.committed_at, remaining: r.remaining }))
}

export function undoBatch(db: Db, batchId: number): { deleted: number } {
  let deleted = 0
  db.transaction(() => {
    deleted = db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batchId).changes
    db.prepare("UPDATE import_batches SET status = 'discarded' WHERE id = ?").run(batchId)
  })()
  return { deleted }
}
