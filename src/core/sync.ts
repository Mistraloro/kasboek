/**
 * Sync between computers through a shared folder (no server). The engine, without files or
 * crypto, so it can be tested with two databases.
 *
 * - Triggers note which rows changed (sync-schema). `flush` turns those into a change list: per
 *   row, the fields that changed, each with a timestamp. `sync_rows` remembers the last synced
 *   state of every row.
 * - `apply` merges another computer's changes field by field: the newer timestamp wins. When the
 *   other computer changed a field without having seen this computer's latest value for it (a
 *   real clash), a note is kept so nothing disappears silently. A deletion always wins over edits.
 * - Timestamps are hybrid logical clocks: wall time, a counter and the device id, so they sort the
 *   same everywhere and a change made after seeing another one always sorts after it.
 */
import type { Statement } from 'better-sqlite3-multiple-ciphers'
import type { Db } from './database'
import { fxChanged } from './fx'
import { SPEC, SYNC_TABLES, type TableSpec } from './sync-schema'

export type Value = string | number | null
/** A change to one row. `f`: field → [value, timestamp, the timestamp the sender had before]. */
export type Change =
  | {
      t: string
      u: string
      op: 'upsert'
      f: Record<string, [Value, string, string | null]>
    }
  | { t: string; u: string; op: 'delete'; ts: string }

interface RowState {
  data: Record<string, Value>
  ts: Record<string, string>
  deleted: string | null
}

/* ---------- Prepared statements ---------- */

// The engine runs the same few statements once per row: prepare each only once per database.
type Stmt = Statement<unknown[], unknown>
const statements = new WeakMap<Db, Map<string, Stmt>>()
function q(db: Db, sql: string): Stmt {
  let m = statements.get(db)
  if (!m) statements.set(db, (m = new Map()))
  let st = m.get(sql)
  if (!st) m.set(sql, (st = db.prepare<unknown[], unknown>(sql)))
  return st
}

/* ---------- Meta, clock ---------- */

export function getMeta(db: Db, key: string): string | null {
  return (q(db, 'SELECT value FROM sync_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

export function setMeta(db: Db, key: string, value: string | null): void {
  if (value === null) q(db, 'DELETE FROM sync_meta WHERE key = ?').run(key)
  else q(db, 'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0')

/** A new timestamp, later than anything this database has seen. */
export function tick(db: Db, device: string, now = Date.now()): string {
  const last = getMeta(db, 'clock')
  let ms = now
  let counter = 0
  if (last) {
    const lastMs = Number(last.slice(0, 15))
    const lastCounter = Number(last.slice(16, 20))
    if (lastMs >= ms) {
      ms = lastMs
      counter = lastCounter + 1
      // Keep the counter at four digits so timestamps keep sorting as text.
      if (counter > 9999) {
        ms++
        counter = 0
      }
    }
  }
  const ts = `${pad(ms, 15)}-${pad(counter, 4)}-${device}`
  setMeta(db, 'clock', ts)
  return ts
}

/** Moves the clock past a timestamp from elsewhere. */
function observe(db: Db, ts: string): void {
  const last = getMeta(db, 'clock')
  if (!last || ts.slice(0, 20) > last.slice(0, 20)) setMeta(db, 'clock', ts.slice(0, 20) + '-' + (last?.slice(21) ?? 'x'))
}

export function isEnabled(db: Db): boolean {
  return (q(db, 'SELECT enabled FROM sync_flags').get() as { enabled: number }).enabled === 1
}

function setApplying(db: Db, on: boolean): void {
  db.prepare('UPDATE sync_flags SET applying = ?').run(on ? 1 : 0)
}

/* ---------- Rows ↔ records ---------- */

function uidOf(db: Db, table: string, id: number | null): string | null {
  if (id === null || id === undefined) return null
  return (q(db, `SELECT uid FROM ${table} WHERE id = ?`).get(id) as { uid: string | null } | undefined)?.uid ?? null
}

function idOf(db: Db, table: string, uid: Value): number | null | undefined {
  if (uid === null) return null
  const r = q(db, `SELECT id FROM ${table} WHERE uid = ?`).get(uid) as { id: number } | undefined
  return r ? r.id : undefined
}

/** The row as it travels: its fields, with foreign keys as uids. Null when it doesn't exist or isn't synced. */
function readRecord(db: Db, s: TableSpec, uid: string): Record<string, Value> | null {
  const where = s.when ? ` AND ${s.when('NEW').replaceAll('NEW.', '')}` : ''
  const row = db.prepare(`SELECT * FROM ${s.table} WHERE uid = ?${where}`).get(uid) as Record<string, Value> | undefined
  if (!row) return null
  const out: Record<string, Value> = {}
  for (const c of s.cols) out[c] = s.fks[c] ? uidOf(db, s.fks[c]!, row[c] as number | null) : (row[c] ?? null)
  return out
}

function readState(db: Db, table: string, uid: string): RowState | null {
  const r = db.prepare('SELECT data, ts, deleted FROM sync_rows WHERE tbl = ? AND uid = ?').get(table, uid) as
    | { data: string; ts: string; deleted: string | null }
    | undefined
  return r ? { data: JSON.parse(r.data), ts: JSON.parse(r.ts), deleted: r.deleted } : null
}

function writeState(db: Db, table: string, uid: string, st: RowState): void {
  q(
    db,
    `INSERT INTO sync_rows (tbl, uid, data, ts, deleted) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tbl, uid) DO UPDATE SET data = excluded.data, ts = excluded.ts, deleted = excluded.deleted`
  ).run(table, uid, JSON.stringify(st.data), JSON.stringify(st.ts), st.deleted)
}

const same = (a: Value | undefined, b: Value | undefined): boolean => (a ?? null) === (b ?? null)

/* ---------- Turning sync on ---------- */

/**
 * Starts recording changes, with everything currently here as the synced starting point. Used
 * by the first computer; others start from its snapshot, which carries this state along.
 */
export function enable(db: Db, device: string): void {
  db.transaction(() => {
    // One timestamp for the whole starting point: every later change sorts after it.
    const ts = tick(db, device)
    for (const s of SYNC_TABLES) {
      const uids = db.prepare(`SELECT uid FROM ${s.table} WHERE uid IS NOT NULL`).all() as { uid: string }[]
      for (const { uid } of uids) {
        if (readState(db, s.table, uid)) continue
        const rec = readRecord(db, s, uid)
        if (!rec) continue
        writeState(db, s.table, uid, {
          data: rec,
          ts: Object.fromEntries(Object.keys(rec).map((k) => [k, ts])),
          deleted: null
        })
      }
    }
    db.prepare('DELETE FROM sync_outbox').run()
    db.prepare('UPDATE sync_flags SET enabled = 1, applying = 0').run()
  })()
}

export function disable(db: Db): void {
  db.prepare('UPDATE sync_flags SET enabled = 0, applying = 0').run()
  db.prepare('DELETE FROM sync_outbox').run()
}

/* ---------- Outgoing ---------- */

/** Collects the local changes since the last flush, marks them as synced and returns them. */
export function flush(db: Db, device: string): Change[] {
  const changes: Change[] = []
  db.transaction(() => {
    const pending = db.prepare('SELECT DISTINCT tbl, uid FROM sync_outbox').all() as { tbl: string; uid: string }[]
    // Parents before children, so the receiver can resolve references in one pass.
    const order = new Map(SYNC_TABLES.map((s, i) => [s.table, i]))
    pending.sort((a, b) => (order.get(a.tbl) ?? 99) - (order.get(b.tbl) ?? 99))
    for (const { tbl, uid } of pending) {
      const s = SPEC.get(tbl)
      if (!s) continue
      const rec = readRecord(db, s, uid)
      const prev = readState(db, tbl, uid)
      if (!rec) {
        if (prev && !prev.deleted) {
          const ts = tick(db, device)
          changes.push({ t: tbl, u: uid, op: 'delete', ts })
          writeState(db, tbl, uid, { ...prev, deleted: ts })
        }
        continue
      }
      // A row deleted elsewhere stays deleted (deletion wins); local edits to it are not sent.
      if (prev?.deleted) continue
      const f: Record<string, [Value, string, string | null]> = {}
      const next: RowState = prev ? { data: { ...prev.data }, ts: { ...prev.ts }, deleted: null } : { data: {}, ts: {}, deleted: null }
      for (const c of s.cols) {
        if (prev && c in prev.data && same(prev.data[c], rec[c])) continue
        const ts = tick(db, device)
        f[c] = [rec[c] ?? null, ts, prev?.ts[c] ?? null]
        next.data[c] = rec[c] ?? null
        next.ts[c] = ts
      }
      if (!Object.keys(f).length) continue
      changes.push({ t: tbl, u: uid, op: 'upsert', f })
      writeState(db, tbl, uid, next)
    }
    db.prepare('DELETE FROM sync_outbox').run()
  })()
  return changes
}

/* ---------- Incoming ---------- */

export interface ApplyResult {
  applied: number
  conflicts: number
  deferred: number
}

type Describe = (table: string, data: Record<string, Value>) => string

/** Writes one row to its table (insert or update), mapping uids back to local ids. */
function writeRow(db: Db, s: TableSpec, uid: string, data: Record<string, Value>, exists: boolean): 'ok' | 'missing_ref' | 'skipped' {
  const values: Record<string, Value> = {}
  for (const c of s.cols) {
    if (!(c in data)) continue
    if (s.fks[c]) {
      const id = idOf(db, s.fks[c]!, data[c] ?? null)
      if (id === undefined) return 'missing_ref'
      values[c] = id
    } else values[c] = data[c] ?? null
  }
  const run = (v: Record<string, Value>): void => {
    const cols = Object.keys(v)
    if (exists) {
      if (cols.length) db.prepare(`UPDATE ${s.table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE uid = @uid`).run({ ...v, uid })
    } else db.prepare(`INSERT INTO ${s.table} (uid, ${cols.join(', ')}) VALUES (@uid, ${cols.map((c) => `@${c}`).join(', ')})`).run({ ...v, uid })
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      run(values)
      return 'ok'
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (/NOT NULL/.test(msg) && !exists) return 'missing_ref'
      if (!/UNIQUE/.test(msg)) throw err
      // The same thing made on two computers under different ids.
      if (s.table === 'categories' && typeof values['name'] === 'string') values['name'] = `${String(data['name'])} (${attempt + 2})`
      else if (s.table === 'accounts' && values['iban'] != null) values['iban'] = null
      else return 'skipped'
    }
  }
  return 'skipped'
}

function deleteRow(db: Db, s: TableSpec, uid: string): void {
  // Transactions point at categories/accounts: let the database's own rules handle it.
  db.prepare(`DELETE FROM ${s.table} WHERE uid = ?`).run(uid)
}

/**
 * Applies changes from another computer. Runs inside one transaction; the triggers don't record
 * these writes as local changes.
 */
export function apply(db: Db, me: string, from: string, changes: Change[], describe: Describe = defaultDescribe): ApplyResult {
  const result: ApplyResult = { applied: 0, conflicts: 0, deferred: 0 }
  const note = (summary: string): void => {
    db.prepare("INSERT INTO sync_conflicts (at, summary) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)").run(summary)
    result.conflicts++
  }
  db.transaction(() => {
    setApplying(db, true)
    try {
      // New changes, then earlier deferred ones (their references may have arrived), repeated
      // while that makes progress.
      const waiting = db.prepare('SELECT id, device, change FROM sync_pending ORDER BY id').all() as { id: number; device: string; change: string }[]
      db.prepare('DELETE FROM sync_pending').run()
      let queue: { device: string; c: Change }[] = [
        ...changes.map((c) => ({ device: from, c })),
        ...waiting.map((w) => ({
          device: w.device,
          c: JSON.parse(w.change) as Change
        }))
      ]
      let touchedFx = false
      for (;;) {
        const deferred: { device: string; c: Change }[] = []
        const appliedBefore = result.applied
        for (const { device, c } of queue) {
          const s = SPEC.get(c.t)
          if (!s) continue
          if (c.t === 'fx_rates') touchedFx = true
          const prev = readState(db, c.t, c.u)
          if (c.op === 'delete') {
            observe(db, c.ts)
            if (prev?.deleted) continue
            if (prev) {
              const editedLater = Object.values(prev.ts).some((t) => t > c.ts && t.endsWith(`-${me}`))
              if (editedLater) note(`${describe(c.t, prev.data)} was deleted on another computer, after it was changed here. It has been deleted.`)
            }
            deleteRow(db, s, c.u)
            writeState(db, c.t, c.u, {
              data: prev?.data ?? {},
              ts: prev?.ts ?? {},
              deleted: c.ts
            })
            result.applied++
            continue
          }
          // upsert
          for (const [, ts] of Object.values(c.f)) observe(db, ts)
          if (prev?.deleted) continue
          const next: RowState = prev ? { data: { ...prev.data }, ts: { ...prev.ts }, deleted: null } : { data: {}, ts: {}, deleted: null }
          const changed: Record<string, Value> = {}
          for (const [field, [value, ts, base]] of Object.entries(c.f)) {
            const localTs = next.ts[field] ?? null
            // A real clash: the sender hadn't seen the value this computer wrote.
            const clash =
              !QUIET.has(field) && prev !== null && localTs !== null && localTs.endsWith(`-${me}`) && base !== localTs && !same(next.data[field], value)
            if (localTs === null || ts > localTs) {
              if (clash)
                note(
                  `${describe(c.t, next.data)}: ${label(field)} was changed on two computers. Kept the later change (${show(value)}); the other was ${show(next.data[field])}.`
                )
              next.data[field] = value
              next.ts[field] = ts
              changed[field] = value
            } else if (clash) {
              note(
                `${describe(c.t, next.data)}: ${label(field)} was changed on two computers. Kept the later change (${show(next.data[field])}); the other was ${show(value)}.`
              )
            }
          }
          if (!Object.keys(changed).length && prev) continue
          const exists = !!db.prepare(`SELECT 1 FROM ${c.t} WHERE uid = ?`).get(c.u)
          const outcome = writeRow(db, s, c.u, exists ? changed : next.data, exists)
          if (outcome === 'missing_ref') {
            deferred.push({ device, c })
            continue
          }
          writeState(db, c.t, c.u, next)
          result.applied++
        }
        if (!deferred.length || result.applied === appliedBefore) {
          for (const d of deferred) db.prepare('INSERT INTO sync_pending (device, change) VALUES (?, ?)').run(d.device, JSON.stringify(d.c))
          result.deferred = deferred.length
          break
        }
        queue = deferred
      }
      if (touchedFx) fxChanged(db)
    } finally {
      setApplying(db, false)
    }
  })()
  return result
}

/** Bookkeeping fields: merged like the others, but never worth a note. */
const QUIET = new Set(['updated_at', 'created_at', 'sort_order'])

const LABELS: Record<string, string> = {
  category_id: 'category',
  account_id: 'account',
  amount_cents: 'amount',
  booking_date: 'date',
  counterparty_name: 'counterparty',
  opening_balance_cents: 'opening balance',
  value_cents: 'value',
  per_eur: 'rate'
}
const label = (field: string): string => LABELS[field] ?? field.replaceAll('_', ' ')
const show = (v: Value | undefined): string =>
  v === null || v === undefined || v === '' ? 'empty' : typeof v === 'number' ? String(v) : `“${String(v).slice(0, 60)}”`

function defaultDescribe(table: string, data: Record<string, Value>): string {
  switch (table) {
    case 'transactions':
      return `Transaction “${String(data['counterparty_name'] || data['description'] || '?').slice(0, 50)}” (${String(data['booking_date'] ?? '')})`
    case 'accounts':
      return `Account “${String(data['name'] ?? '?')}”`
    case 'categories':
      return `Category “${String(data['name'] ?? '?')}”`
    case 'budgets':
      return `Budget for ${String(data['month'] ?? '?')}`
    case 'rules':
      return `Rule “${String(data['pattern'] ?? '?')}”`
    case 'valuations':
      return `Value on ${String(data['date'] ?? '?')}`
    default:
      return table.replaceAll('_', ' ')
  }
}

/* ---------- Cursors and conflicts ---------- */

export function cursors(db: Db): Record<string, number> {
  return JSON.parse(getMeta(db, 'cursors') ?? '{}') as Record<string, number>
}

export function setCursor(db: Db, device: string, seq: number): void {
  setMeta(db, 'cursors', JSON.stringify({ ...cursors(db), [device]: seq }))
}

export function listConflicts(db: Db): { id: number; at: string; summary: string }[] {
  return db.prepare('SELECT id, at, summary FROM sync_conflicts WHERE dismissed = 0 ORDER BY id DESC LIMIT 200').all() as {
    id: number
    at: string
    summary: string
  }[]
}

export function dismissConflicts(db: Db): void {
  db.prepare('UPDATE sync_conflicts SET dismissed = 1 WHERE dismissed = 0').run()
}
