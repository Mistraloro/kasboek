/**
 * Net worth, investments and the year view.
 *
 * An account's value on a day is its opening balance plus its transactions up to that day. When
 * the person recorded a value for the account (a broker portfolio, a house, or the balance the bank
 * showed), the latest recorded value counts instead, plus the transactions after it; before the
 * first recorded balance of a bank account, its value is worked back from that balance. Everything is converted to the main
 * currency with the rate of that day.
 */
import { addMonths, localToday, monthRange } from '@shared/month'
import type { AccountKind, NetWorth, NetWorthAccount, Valuation, YearSummary } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { INCOME_SQL, SPENDING_SQL } from './finance'
import { convert } from './fx'
import { getSettings } from './settings'

interface AccountRow {
  id: number
  name: string
  kind: AccountKind
  currency: string
  opening_balance_cents: number
  archived: number
  created_at: string
}

interface History {
  /** Transaction dates and running totals (account currency), sorted. */
  dates: string[]
  running: number[]
  valuations: { date: string; value: number }[]
}

function history(db: Db, a: AccountRow): History {
  const rows = db
    .prepare(`SELECT booking_date AS d, sum(coalesce(fx(amount_cents, currency, booking_date, ?), 0)) AS a FROM transactions WHERE account_id = ? GROUP BY booking_date ORDER BY booking_date`)
    .all(a.currency, a.id) as { d: string; a: number }[]
  const dates: string[] = []
  const running: number[] = []
  let total = 0
  for (const r of rows) {
    total += r.a
    dates.push(r.d)
    running.push(total)
  }
  const valuations = (db.prepare('SELECT date, value_cents AS value FROM valuations WHERE account_id = ? ORDER BY date').all(a.id) as { date: string; value: number }[])
  return { dates, running, valuations }
}

/** Sum of transactions on or before `date`. */
function txUpTo(h: History, date: string): number {
  let lo = 0
  let hi = h.dates.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (h.dates[mid]! <= date) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found < 0 ? 0 : h.running[found]!
}

function valueOn(a: AccountRow, h: History, date: string): { value: number; invested: number; valuation: { date: string; value: number } | null } {
  const invested = a.opening_balance_cents + txUpTo(h, date)
  let valuation: { date: string; value: number } | null = null
  for (const v of h.valuations) if (v.date <= date) valuation = v
  if (!valuation) {
    // A bank account before its first recorded balance: work back from that balance, so the
    // starting balance doesn't have to be known. (An investment counts what was paid in.)
    const next = h.valuations[0]
    if (next && a.kind !== 'investment') return { value: next.value - (txUpTo(h, next.date) - txUpTo(h, date)), invested, valuation: null }
    return { value: invested, invested, valuation: null }
  }
  return { value: valuation.value + txUpTo(h, date) - txUpTo(h, valuation.date), invested, valuation }
}

const LIABILITIES: AccountKind[] = ['credit_card', 'loan']

const monthEnd = (month: string): string => {
  const next = monthRange(month).to
  const d = new Date(`${next}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function netWorth(db: Db, opts: { months: number }, today = localToday()): NetWorth {
  const main = getSettings(db).currency
  const accounts = db.prepare('SELECT id, name, kind, currency, opening_balance_cents, archived, created_at FROM accounts ORDER BY archived, name').all() as AccountRow[]
  const histories = new Map(accounts.map((a) => [a.id, history(db, a)]))

  let assets = 0
  let liabilities = 0
  let unconverted = 0
  const rows: NetWorthAccount[] = accounts.map((a) => {
    const h = histories.get(a.id)!
    const v = valueOn(a, h, today)
    const valueMain = convert(db, v.value, a.currency, today, main)
    if (valueMain === null) unconverted++
    else if (LIABILITIES.includes(a.kind) || valueMain < 0) liabilities += valueMain
    else assets += valueMain
    const tracked = h.valuations.length > 0
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      currency: a.currency,
      archived: a.archived === 1,
      valueCents: v.value,
      valueMainCents: valueMain,
      investedCents: tracked ? v.invested : null,
      gainCents: tracked ? v.value - v.invested : null,
      lastValuation: v.valuation ? { date: v.valuation.date, valueCents: v.valuation.value } : null
    }
  })

  // Month-end values, from the first month with any data (or `months` back) to this month.
  const thisMonth = today.slice(0, 7)
  const first = (db.prepare(`SELECT min(d) AS d FROM (SELECT min(booking_date) AS d FROM transactions UNION SELECT min(date) FROM valuations UNION SELECT min(substr(created_at, 1, 10)) FROM accounts)`).get() as { d: string | null }).d
  let start = opts.months > 0 ? addMonths(thisMonth, -(opts.months - 1)) : (first?.slice(0, 7) ?? thisMonth)
  if (first && start < first.slice(0, 7)) start = first.slice(0, 7)
  const history_: NetWorth['history'] = []
  for (let m = start; m <= thisMonth; m = addMonths(m, 1)) {
    const day = m === thisMonth ? today : monthEnd(m)
    let total = 0
    let missing = 0
    for (const a of accounts) {
      const v = valueOn(a, histories.get(a.id)!, day).value
      if (v === 0) continue
      const c = convert(db, v, a.currency, day, main)
      if (c === null) missing++
      else total += c
    }
    history_.push({ month: m, cents: total, unconverted: missing })
  }
  return { main, totalCents: assets + liabilities, assetsCents: assets, liabilitiesCents: liabilities, unconverted, accounts: rows, history: history_ }
}

export function listValuations(db: Db, accountId: number): Valuation[] {
  return (db.prepare('SELECT account_id, date, value_cents, note FROM valuations WHERE account_id = ? ORDER BY date DESC').all(accountId) as { account_id: number; date: string; value_cents: number; note: string | null }[]).map((r) => ({
    accountId: r.account_id,
    date: r.date,
    valueCents: r.value_cents,
    note: r.note
  }))
}

export function setValuation(db: Db, input: { accountId: number; date: string; valueCents: number; note?: string | null }): Valuation[] {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.accountId)) throw new AppError('accounts.not_found', 'Account not found.')
  db.prepare(
    `INSERT INTO valuations (account_id, date, value_cents, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, date) DO UPDATE SET value_cents = excluded.value_cents, note = excluded.note`
  ).run(input.accountId, input.date, input.valueCents, input.note ?? null)
  return listValuations(db, input.accountId)
}

export function deleteValuation(db: Db, input: { accountId: number; date: string }): Valuation[] {
  db.prepare('DELETE FROM valuations WHERE account_id = ? AND date = ?').run(input.accountId, input.date)
  return listValuations(db, input.accountId)
}

/** Income and spending per month and per category for one year, plus totals for every year. */
export function yearSummary(db: Db, year: number): YearSummary {
  const main = getSettings(db).currency
  const FX = `fx(t.amount_cents, t.currency, t.booking_date, ?)`
  const from = `${year}-01-01`
  const to = `${year + 1}-01-01`
  const rows = db
    .prepare(
      `SELECT substr(t.booking_date, 6, 2) AS m, t.category_id AS cat, c.name AS name, coalesce(c.kind, 'expense') AS kind,
              coalesce(sum(CASE WHEN t.amount_cents > 0 THEN ${FX} END), 0) AS inc,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN ${FX} END), 0) AS out
       FROM tx_lines t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.booking_date >= ? AND t.booking_date < ?
       GROUP BY m, t.category_id`
    )
    .all(main, main, from, to) as { m: string; cat: number | null; name: string | null; kind: string; inc: number; out: number }[]

  const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, incomeCents: 0, spendingCents: 0 }))
  const cats = new Map<string, YearSummary['categories'][number]>()
  for (const r of rows) {
    if (r.kind === 'transfer') continue
    const i = Number(r.m) - 1
    // Refunds lower spending, reversals lower income (as in the month summary).
    if (r.cat === null) {
      months[i]!.incomeCents += r.inc
      months[i]!.spendingCents += r.out
    } else if (r.kind === 'income') months[i]!.incomeCents += r.inc - r.out
    else months[i]!.spendingCents += r.out - r.inc
    // Spending categories count money out minus refunds; income categories money in minus reversals.
    // Uncategorised money in is listed under income, money out under spending.
    const parts: ['income' | 'expense', number][] =
      r.cat === null ? [['income', r.inc], ['expense', r.out]] : [[r.kind === 'income' ? 'income' : 'expense', r.kind === 'income' ? r.inc - r.out : r.out - r.inc]]
    for (const [kind, amount] of parts) {
      if (!amount) continue
      const key = `${kind}:${r.cat ?? 'none'}`
      let c = cats.get(key)
      if (!c) cats.set(key, (c = { categoryId: r.cat, name: r.name ?? '', kind, months: Array(12).fill(0) as number[], totalCents: 0 }))
      c.months[i]! += amount
      c.totalCents += amount
    }
  }
  const categories = [...cats.values()].filter((c) => c.totalCents !== 0).sort((a, b) => (a.kind === b.kind ? b.totalCents - a.totalCents : a.kind === 'income' ? -1 : 1))

  const years = (
    db
      .prepare(
        `SELECT CAST(substr(t.booking_date, 1, 4) AS INTEGER) AS y, ${INCOME_SQL} AS inc, ${SPENDING_SQL} AS out
         FROM tx_lines t LEFT JOIN categories c ON c.id = t.category_id
         WHERE c.kind IS NULL OR c.kind != 'transfer'
         GROUP BY y ORDER BY y`
      )
      .all(main, main) as { y: number; inc: number; out: number }[]
  ).map((r) => ({ year: r.y, incomeCents: r.inc, spendingCents: r.out }))

  const income = months.reduce((s, m) => s + m.incomeCents, 0)
  const spending = months.reduce((s, m) => s + m.spendingCents, 0)
  const budgets = (db.prepare('SELECT coalesce(sum(amount_cents), 0) AS b FROM budgets WHERE month >= ? AND month <= ?').get(`${year}-01`, `${year}-12`) as { b: number }).b
  return { year, months, categories, incomeCents: income, spendingCents: spending, budgetedCents: budgets, years }
}
