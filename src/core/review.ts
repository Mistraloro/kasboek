/**
 * The facts for a monthly review: each spending category against the three months before,
 * budgets that went over, and payments that stand out. The assistant writes the review from these.
 */
import { addMonths, monthRange } from '@shared/month'
import type { MonthReview } from '@shared/types'
import { groupKey } from './assist-plan'
import type { Db } from './database'
import { listBudgets, monthSummary } from './finance'
import { getSettings } from './settings'

const monthsBefore = (db: Db, month: string): ReturnType<typeof monthSummary>[] => [1, 2, 3].map((n) => monthSummary(db, addMonths(month, -n)))

/** Each spending category of `month` against its average of the three months before, the biggest change first (the top 15). */
export function categoryTrend(db: Db, month: string, now = monthSummary(db, month), before = monthsBefore(db, month)): MonthReview['categories'] {
  const names = new Map<number | null, string>()
  const spent = (s: ReturnType<typeof monthSummary>): Map<number | null, number> => {
    for (const c of s.byCategory) names.set(c.categoryId, c.name)
    return new Map(s.byCategory.map((c) => [c.categoryId, c.cents]))
  }
  const nowBy = spent(now)
  const beforeBy = before.map(spent)
  const ids = new Set([...nowBy.keys(), ...beforeBy.flatMap((m) => [...m.keys()])])
  return [...ids]
    .map((id) => {
      const cents = nowBy.get(id) ?? 0
      const average = Math.round(beforeBy.reduce((t, m) => t + (m.get(id) ?? 0), 0) / beforeBy.length)
      return { categoryId: id, name: names.get(id) ?? '', cents, averageCents: average, changeCents: cents - average }
    })
    .filter((c) => c.cents || c.averageCents)
    .sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents))
    .slice(0, 15)
}

export function monthReview(db: Db, month: string): MonthReview {
  const main = getSettings(db).currency
  const now = monthSummary(db, month)
  const before = monthsBefore(db, month)
  const avg = (pick: (s: ReturnType<typeof monthSummary>) => number): number => Math.round(before.reduce((t, s) => t + pick(s), 0) / before.length)
  const categories = categoryTrend(db, month, now, before)
  const overBudget = listBudgets(db, month)
    .filter((b) => b.budgetCents !== null && b.spentCents > b.budgetCents)
    .map((b) => ({ categoryId: b.categoryId, name: b.name, budgetCents: b.budgetCents!, spentCents: b.spentCents }))

  // Payments that stand out: far above what this payee usually costs, or a large first payment.
  const r = monthRange(month)
  const history = monthRange(addMonths(month, -12))
  const rows = db
    .prepare(
      `SELECT t.id, t.booking_date, t.amount_cents, t.counterparty_name, t.description, t.counterparty_iban, c.name AS category_name,
              coalesce(fx(t.amount_cents, t.currency, t.booking_date, ?), 0) AS main
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.amount_cents < 0 AND t.booking_date >= ? AND t.booking_date < ? AND t.transfer_pair IS NULL AND (c.kind IS NULL OR c.kind <> 'transfer')
       ORDER BY t.booking_date`
    )
    .all(main, history.from, r.to) as { id: number; booking_date: string; amount_cents: number; counterparty_name: string | null; description: string; counterparty_iban: string | null; category_name: string | null; main: number }[]
  const earlier = new Map<string, number[]>()
  const thisMonth: typeof rows = []
  for (const t of rows) {
    if (t.booking_date >= r.from) thisMonth.push(t)
    else {
      const k = groupKey({ counterpartyName: t.counterparty_name, description: t.description, amountCents: t.amount_cents })
      earlier.set(k, [...(earlier.get(k) ?? []), -t.main])
    }
  }
  const outs = thisMonth.map((t) => -t.main).sort((a, b) => a - b)
  const large = outs.length ? outs[Math.floor(outs.length * 0.9)]! : 0
  const unusual = thisMonth
    .flatMap((t) => {
      const past = earlier.get(groupKey({ counterpartyName: t.counterparty_name, description: t.description, amountCents: t.amount_cents })) ?? []
      const usual = past.length ? [...past].sort((a, b) => a - b)[past.length >> 1]! : null
      const cents = -t.main
      const reason: 'higher' | 'new' | null = usual !== null && past.length >= 2 && cents > usual * 2.5 && cents - usual >= 2000 ? 'higher' : usual === null && cents >= Math.max(large, 5000) ? 'new' : null
      return reason ? [{ id: t.id, date: t.booking_date, name: (t.counterparty_name || t.description).slice(0, 60), cents, usualCents: usual, category: t.category_name, reason }] : []
    })
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 8)
  return {
    month,
    incomeCents: now.incomeCents,
    spendingCents: now.spendingCents,
    averageIncomeCents: avg((s) => s.incomeCents),
    averageSpendingCents: avg((s) => s.spendingCents),
    uncategorised: now.uncategorized,
    categories,
    overBudget,
    unusual
  }
}
