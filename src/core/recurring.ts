/**
 * Payments that come back (subscriptions, rent, insurance, loan, energy) and income that does
 * (salary), found from the transactions themselves: the same payee at a steady rhythm with a
 * steady amount. Gives what is still due this month, price changes, and late payments.
 */
import { addMonths, localToday, monthOf } from '@shared/month'
import type { RecurringItem, RecurringSummary } from '@shared/types'
import { groupKey } from './assist-plan'
import type { Db } from './database'
import { AppError } from './errors'

const RHYTHMS: { frequency: RecurringItem['frequency']; days: number; months: number; perMonth: number }[] = [
  { frequency: 'weekly', days: 7, months: 0, perMonth: 52 / 12 },
  { frequency: 'monthly', days: 30.4, months: 1, perMonth: 1 },
  { frequency: 'quarterly', days: 91, months: 3, perMonth: 1 / 3 },
  { frequency: 'yearly', days: 365, months: 12, perMonth: 1 / 12 }
]

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}
/** The same day of the month, `n` months later (the 31st becomes the month's last day). */
function addMonthsToDate(date: string, n: number): string {
  const month = addMonths(date.slice(0, 7), n)
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(Math.min(Number(date.slice(8)), last)).padStart(2, '0')}`
}

interface Row {
  id: number
  booking_date: string
  amount_cents: number
  counterparty_name: string | null
  description: string
  bank_counterparty: string | null
  bank_description: string | null
  counterparty_iban: string | null
  category_id: number | null
  category_name: string | null
  account_id: number
  account_name: string
}

export function findRecurring(db: Db, today = localToday()): RecurringSummary {
  const since = addDays(today, -430)
  const rows = db
    .prepare(
      `SELECT t.id, t.booking_date, t.amount_cents, t.counterparty_name, t.description, t.bank_counterparty, t.bank_description, t.counterparty_iban,
              t.category_id, c.name AS category_name, t.account_id, a.name AS account_name
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.booking_date >= ? AND t.booking_date <= ? AND t.transfer_pair IS NULL AND (c.kind IS NULL OR c.kind <> 'transfer')
       ORDER BY t.booking_date, t.id`
    )
    .all(since, today) as Row[]
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    // The payee as people read it; card payments without a payee by their (bank) description.
    const key = groupKey({ counterpartyName: r.counterparty_name || r.bank_counterparty, description: r.description, amountCents: r.amount_cents, counterpartyIban: r.counterparty_iban })
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const thisMonth = monthOf(new Date(`${today}T12:00:00`))
  const items: RecurringItem[] = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    const gaps = list.slice(1).map((r, i) => dayDiff(list[i]!.booking_date, r.booking_date)).filter((g) => g > 0)
    if (!gaps.length) continue
    const gap = median(gaps)
    const rhythm = RHYTHMS.find((r) => Math.abs(gap - r.days) <= r.days * 0.2)
    if (!rhythm) continue
    // Needs enough repeats for its rhythm, and most gaps close to it.
    const needed = rhythm.frequency === 'yearly' ? 2 : 3
    if (list.length < needed) continue
    const steady = gaps.filter((g) => Math.abs(g - rhythm.days) <= rhythm.days * 0.25).length / gaps.length
    if (steady < 0.7) continue
    const amounts = list.map((r) => r.amount_cents)
    const usual = Math.round(median(amounts.slice(-6)))
    const alike = amounts.filter((a) => Math.abs(a - usual) <= Math.abs(usual) * 0.2).length / amounts.length
    if (alike < 0.6) continue
    const last = list.at(-1)!
    // After a price change the new price is what comes next (unless the last one was an outlier).
    const typical = Math.abs(last.amount_cents - usual) <= Math.abs(usual) * 0.2 ? last.amount_cents : usual
    const previous = list.at(-2)!
    const next = rhythm.months ? addMonthsToDate(last.booking_date, rhythm.months) : addDays(last.booking_date, rhythm.days)
    // Late: a few days past when it was expected, and still not seen.
    const grace = rhythm.frequency === 'weekly' ? 3 : 7
    const status: RecurringItem['status'] =
      last.booking_date.slice(0, 7) === thisMonth && rhythm.frequency !== 'weekly' ? 'paid' : next < today && dayDiff(next, today) > grace ? 'late' : next.slice(0, 7) === thisMonth ? 'due' : 'later'
    const change = last.amount_cents !== previous.amount_cents && Math.abs(last.amount_cents - previous.amount_cents) >= Math.max(100, Math.abs(previous.amount_cents) * 0.02) ? last.amount_cents - previous.amount_cents : null
    items.push({
      key,
      name: (last.counterparty_name || last.bank_counterparty || last.description).slice(0, 60),
      direction: typical < 0 ? 'out' : 'in',
      frequency: rhythm.frequency,
      typicalCents: typical,
      monthlyCents: Math.round(typical * rhythm.perMonth),
      lastCents: last.amount_cents,
      lastDate: last.booking_date,
      nextDate: next,
      count: list.length,
      status,
      priceChangeCents: change,
      categoryId: last.category_id,
      categoryName: last.category_name,
      accountId: last.account_id,
      accountName: last.account_name,
      transactionIds: list.map((r) => r.id)
    })
  }
  items.sort((a, b) => Math.abs(b.monthlyCents) - Math.abs(a.monthlyCents))
  const hiddenKeys = new Set((db.prepare('SELECT key FROM recurring_marks WHERE hidden = 1').all() as { key: string }[]).map((r) => r.key))
  const hidden = items.filter((i) => hiddenKeys.has(i.key))
  const counted = items.filter((i) => !hiddenKeys.has(i.key))
  const out = counted.filter((i) => i.direction === 'out')
  return {
    items: counted,
    hidden,
    monthlyOutCents: -out.reduce((t, i) => t + i.monthlyCents, 0),
    monthlyInCents: counted.filter((i) => i.direction === 'in').reduce((t, i) => t + i.monthlyCents, 0),
    dueThisMonthCents: -out.filter((i) => i.status === 'due' || i.status === 'late').reduce((t, i) => t + i.typicalCents, 0)
  }
}

/**
 * Stops counting a detected item (or counts it again). Only items that are detected now can be
 * hidden, so a made-up key does nothing. A mark is never deleted: for sync a deleted row stays
 * deleted on every computer, so showing again sets `hidden` back to 0 instead.
 */
export function setRecurringHidden(db: Db, key: string, hidden: boolean, today = localToday()): RecurringSummary {
  if (hidden) {
    const found = findRecurring(db, today)
    if (![...found.items, ...found.hidden].some((i) => i.key === key)) throw new AppError('recurring.not_found', 'That fixed cost is not (or no longer) found.')
  } else if (!db.prepare('SELECT 1 FROM recurring_marks WHERE key = ?').get(key)) return findRecurring(db, today)
  db.prepare(
    `INSERT INTO recurring_marks (key, hidden) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET hidden = excluded.hidden, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, hidden ? 1 : 0)
  return findRecurring(db, today)
}
