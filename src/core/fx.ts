/**
 * Currency conversion. Every amount stays stored in its own currency; totals in the main currency
 * are converted with the rate of the transaction's date (the last known rate on or before it, or
 * the first one after it when there is nothing earlier). Rates are stored per euro, so any two
 * currencies convert through the euro, like the ECB reference rates.
 *
 * The SQL function `fx(cents, from, date, to)` does the same inside queries and returns NULL when a
 * currency has no rate at all, so such amounts are left out of totals instead of being guessed.
 */
import type { FxCurrencyInfo, FxRate } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'

interface Series {
  dates: string[]
  rates: number[]
}

// All rates are loaded up front: SQLite does not allow queries from inside the `fx` function.
const cache = new WeakMap<Db, Map<string, Series>>()

function load(db: Db): Map<string, Series> {
  // A manual rate wins over the ECB rate of the same day (it sorts last and replaces it).
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fx_rates'`).get()
  // An older database opened without migrating has no rates table yet.
  const rows = hasTable
    ? (db
        .prepare(`SELECT currency, date, per_eur FROM fx_rates ORDER BY currency, date, CASE source WHEN 'manual' THEN 1 ELSE 0 END`)
        .all() as { currency: string; date: string; per_eur: number }[])
    : []
  const map = new Map<string, Series>()
  for (const r of rows) {
    let s = map.get(r.currency)
    if (!s) map.set(r.currency, (s = { dates: [], rates: [] }))
    if (s.dates[s.dates.length - 1] === r.date) s.rates[s.rates.length - 1] = r.per_eur
    else {
      s.dates.push(r.date)
      s.rates.push(r.per_eur)
    }
  }
  cache.set(db, map)
  return map
}

function series(db: Db, currency: string): Series | null {
  return (cache.get(db) ?? load(db)).get(currency) ?? null
}

/** Units of `currency` for 1 euro on `date`, or null when the currency has no rate at all. */
export function ratePerEur(db: Db, currency: string, date: string): number | null {
  if (currency === 'EUR') return 1
  const s = series(db, currency)
  if (!s) return null
  // Last date <= date (binary search); if none, the first rate.
  let lo = 0
  let hi = s.dates.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s.dates[mid]! <= date) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return s.rates[found === -1 ? 0 : found]!
}

export function convert(db: Db, cents: number, from: string, date: string, to: string): number | null {
  if (from === to) return cents
  const a = ratePerEur(db, from, date)
  const b = ratePerEur(db, to, date)
  if (a === null || b === null) return null
  return Math.round((cents / a) * b)
}

/** Call after rates change. */
export function fxChanged(db: Db): void {
  load(db)
}

export function installFx(db: Db): void {
  load(db)
  db.function('fx', { deterministic: false }, (cents: unknown, from: unknown, date: unknown, to: unknown) => {
    if (typeof cents !== 'number' && typeof cents !== 'bigint') return null
    return convert(db, Number(cents), String(from), String(date), String(to))
  })
}

const CURRENCY = /^[A-Z]{3}$/

/** Currencies in use (accounts, transactions, main currency) other than the euro, with their rates. */
export function currencyInfo(db: Db, main: string): FxCurrencyInfo[] {
  const used = db
    .prepare(
      `SELECT currency FROM accounts UNION SELECT currency FROM transactions UNION SELECT ? UNION SELECT currency FROM fx_rates WHERE source = 'manual'`
    )
    .all(main) as { currency: string }[]
  return used
    .map((u) => u.currency)
    .filter((c) => c !== 'EUR' && CURRENCY.test(c))
    .sort()
    .map((currency) => {
      const latest = db
        .prepare(`SELECT date, per_eur, source FROM fx_rates WHERE currency = ? ORDER BY date DESC, CASE source WHEN 'manual' THEN 0 ELSE 1 END LIMIT 1`)
        .get(currency) as { date: string; per_eur: number; source: 'ecb' | 'manual' } | undefined
      const counts = db.prepare(`SELECT source, count(*) AS n FROM fx_rates WHERE currency = ? GROUP BY source`).all(currency) as { source: string; n: number }[]
      const oldestTx = (db.prepare('SELECT min(booking_date) AS d FROM transactions WHERE currency = ?').get(currency) as { d: string | null }).d
      const firstRate = (db.prepare('SELECT min(date) AS d FROM fx_rates WHERE currency = ?').get(currency) as { d: string | null }).d
      return {
        currency,
        latest: latest ? { date: latest.date, perEur: latest.per_eur, source: latest.source } : null,
        ecbRates: counts.find((c) => c.source === 'ecb')?.n ?? 0,
        manualRates: counts.find((c) => c.source === 'manual')?.n ?? 0,
        // Transactions older than the first rate use that first rate.
        coversOldest: !oldestTx || (firstRate !== null && firstRate <= oldestTx)
      }
    })
}

export function listManualRates(db: Db, currency?: string): FxRate[] {
  const rows = db
    .prepare(`SELECT currency, date, per_eur FROM fx_rates WHERE source = 'manual' ${currency ? 'AND currency = ?' : ''} ORDER BY currency, date DESC`)
    .all(...(currency ? [currency] : [])) as { currency: string; date: string; per_eur: number }[]
  return rows.map((r) => ({ currency: r.currency, date: r.date, perEur: r.per_eur, source: 'manual' as const }))
}

export function setManualRate(db: Db, input: { currency: string; date: string; perEur: number }): void {
  if (input.currency === 'EUR') throw new AppError('fx.eur', 'The euro is the base of all rates; it is always 1.')
  db.prepare(
    `INSERT INTO fx_rates (currency, date, per_eur, source) VALUES (?, ?, ?, 'manual')
     ON CONFLICT(currency, date, source) DO UPDATE SET per_eur = excluded.per_eur`
  ).run(input.currency, input.date, input.perEur)
  fxChanged(db)
}

export function deleteManualRate(db: Db, input: { currency: string; date: string }): void {
  db.prepare(`DELETE FROM fx_rates WHERE source = 'manual' AND currency = ? AND date = ?`).run(input.currency, input.date)
  fxChanged(db)
}

/** Stores ECB reference rates (replacing ECB rows for the same days). Returns how many were new. */
export function storeEcbRates(db: Db, rows: { date: string; currency: string; perEur: number }[]): { added: number; total: number } {
  const before = (db.prepare(`SELECT count(*) AS n FROM fx_rates WHERE source = 'ecb'`).get() as { n: number }).n
  const stmt = db.prepare(
    `INSERT INTO fx_rates (currency, date, per_eur, source) VALUES (?, ?, ?, 'ecb') ON CONFLICT(currency, date, source) DO UPDATE SET per_eur = excluded.per_eur`
  )
  db.transaction(() => {
    for (const r of rows) if (CURRENCY.test(r.currency) && r.perEur > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) stmt.run(r.currency, r.date, r.perEur)
  })()
  fxChanged(db)
  const total = (db.prepare(`SELECT count(*) AS n FROM fx_rates WHERE source = 'ecb'`).get() as { n: number }).n
  return { added: total - before, total }
}

/**
 * Parses the ECB history CSV ("Date,USD,JPY,…" then one line per day; "N/A" where there is no
 * rate). Only currencies in `keep` are returned, to keep the database small.
 */
export function parseEcbCsv(text: string, keep: Set<string>): { date: string; currency: string; perEur: number }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0]!.split(',').map((h) => h.trim())
  if (header[0] !== 'Date') throw new AppError('fx.bad_file', 'The ECB file was not in the expected format.')
  const out: { date: string; currency: string; perEur: number }[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const date = cells[0]!.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    for (let i = 1; i < header.length; i++) {
      const currency = header[i]!
      if (!currency || !keep.has(currency)) continue
      const v = Number(cells[i]?.trim())
      if (Number.isFinite(v) && v > 0) out.push({ date, currency, perEur: v })
    }
  }
  return out
}
