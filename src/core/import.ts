/**
 * CSV import sessions. Nothing is written until commit; the person (or the assistant, with
 * confirmation) can change the mapping, skip rows and set categories first.
 */
import { randomUUID } from 'node:crypto'
import type { ImportBatch, ImportPreview, ImportRow } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { insertTransaction, listRules, matchRule } from './finance'
import { fingerprint } from './fingerprint'
import { autoMap, detectLayout, headerSignature, mappingSchema, type CsvMapping } from './csv/mapping'
import { normalizeRows, type CleanRow } from './csv/normalize'
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
    notes: []
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

function buildRows(db: Db, s: Session): { clean: CleanRow; row: ImportRow; fingerprint: string | null }[] {
  if (!s.mapping) return []
  const currency = (db.prepare('SELECT currency FROM accounts WHERE id = ?').get(s.accountId) as { currency: string }).currency
  const clean = normalizeRows(s.rows, s.mapping, currency)
  const rules = listRules(db)
  const existing = db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ? AND fingerprint = ?')
  const seen = new Map<string, number>()
  return clean.map((c) => {
    const o = s.overrides.get(c.index) ?? {}
    const merged: CleanRow = {
      ...c,
      bookingDate: o.bookingDate ?? c.bookingDate,
      amountCents: o.amountCents ?? c.amountCents,
      description: o.description ?? c.description,
      counterpartyName: o.counterpartyName !== undefined ? o.counterpartyName : c.counterpartyName
    }
    // Duplicates are recognised on the bank's own text, so a cleaned-up name or description still
    // matches the same transaction imported earlier (only corrected dates and amounts count).
    let fp: string | null = null
    const issues = c.issues.filter((i) => !(i === 'date_invalid' && o.bookingDate) && !(i.startsWith('amount') && o.amountCents))
    let status: ImportRow['status'] = 'ready'
    if (issues.some((i) => i !== 'currency_other')) status = issues.includes('status_refused') ? 'skipped' : 'problem'
    else if (merged.bookingDate && merged.amountCents !== null) {
      fp = fingerprint({ accountId: s.accountId, bookingDate: merged.bookingDate, amountCents: merged.amountCents, counterpartyName: c.counterpartyName, description: c.description, bankReference: c.bankReference })
      // The n-th copy of a transaction counts as a duplicate only if the account already has n of them.
      const nth = (seen.get(fp) ?? 0) + 1
      seen.set(fp, nth)
      if ((existing.get(s.accountId, fp) as { n: number }).n >= nth) status = 'duplicate'
    }
    if (o.decided === 'skip') status = 'skipped'
    if (o.decided === 'include' && status !== 'problem') status = 'ready'
    // Rules match the cleaned-up text or the bank's own.
    const rule = o.categoryId === undefined ? (matchRule(db, merged, rules) ?? matchRule(db, c, rules)) : undefined
    return {
      clean: merged,
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
        issues,
        status,
        decided: o.decided ?? null,
        note: o.note ?? null
      }
    }
  })
}

export function preview(db: Db, id: string): ImportPreview {
  const s = session(id)
  const rows = buildRows(db, s).map((r) => r.row)
  const ready = rows.filter((r) => r.status === 'ready')
  const dates = ready.map((r) => r.bookingDate!).sort()
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
      problems: rows.filter((r) => r.status === 'problem').length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      inCents: ready.reduce((t, r) => t + Math.max(0, r.amountCents ?? 0), 0),
      outCents: ready.reduce((t, r) => t - Math.min(0, r.amountCents ?? 0), 0),
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null
    },
    notes: s.notes
  }
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

export function commit(db: Db, id: string, saveProfile: boolean): { batchId: number; imported: number; skipped: number } {
  const s = session(id)
  if (!s.mapping) throw new AppError('import.no_mapping', 'Choose which columns hold the date and amount first.')
  const built = buildRows(db, s)
  const ready = built.filter((b) => b.row.status === 'ready')
  if (!ready.length) throw new AppError('import.nothing', 'There are no rows ready to import.')
  const currency = (db.prepare('SELECT currency FROM accounts WHERE id = ?').get(s.accountId) as { currency: string }).currency
  let batchId = 0
  db.transaction(() => {
    batchId = Number(
      db.prepare("INSERT INTO import_batches (account_id, file_name, csv_profile, row_count, status, committed_at) VALUES (?, ?, ?, ?, 'committed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        .run(s.accountId, s.fileName, s.layout, ready.length).lastInsertRowid
    )
    for (const { clean, row, fingerprint: fp } of ready) {
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
        fingerprint: fp ?? undefined
      })
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
  return { batchId, imported: ready.length, skipped: built.length - ready.length }
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
