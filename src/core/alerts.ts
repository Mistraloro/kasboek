/**
 * Warnings: a budget at 80% or more this month, and an account whose balance would go below zero
 * before the next income, counting the fixed costs still due until then.
 */
import { localToday, monthOf } from '@shared/month'
import type { Alert } from '@shared/types'
import { currentBalance } from './balance'
import type { Db } from './database'
import { listBudgets } from './finance'
import { findRecurring } from './recurring'

/** A budget is nearly used up from this share of it. */
export const NEAR = 0.8

export function listAlerts(db: Db, today = localToday()): Alert[] {
  const month = monthOf(new Date(`${today}T12:00:00`))
  const alerts: Alert[] = []
  for (const b of listBudgets(db, month)) {
    if (!b.budgetCents || b.budgetCents <= 0 || b.spentCents < b.budgetCents * NEAR) continue
    const level = b.spentCents > b.budgetCents ? 'over' : 'near'
    alerts.push({ kind: 'budget', key: `budget:${month}:${b.categoryId}:${level}`, categoryId: b.categoryId, name: b.name, budgetCents: b.budgetCents, spentCents: b.spentCents, level })
  }

  // Balances: only for accounts whose balance is known (a bank balance was recorded, or a start).
  const recurring = findRecurring(db, today).items
  const accounts = db
    .prepare(
      `SELECT a.id, a.name, a.currency FROM accounts a
       WHERE a.archived = 0 AND a.kind = 'current' AND (a.opening_balance_cents <> 0 OR EXISTS (SELECT 1 FROM valuations v WHERE v.account_id = a.id))`
    )
    .all() as { id: number; name: string; currency: string }[]
  for (const a of accounts) {
    const income = recurring.filter((r) => r.direction === 'in' && r.accountId === a.id && r.nextDate >= today).sort((x, y) => x.nextDate.localeCompare(y.nextDate))[0]
    const until = income?.nextDate ?? endOfMonth(today)
    // Fixed costs on this account still to come before then (late ones too: not paid yet).
    const due = recurring.filter((r) => r.direction === 'out' && r.accountId === a.id && (r.status === 'late' || (r.nextDate >= today && r.nextDate <= until)))
    const dueCents = due.reduce((t, r) => t + r.typicalCents, 0)
    const balance = currentBalance(db, a.id)
    const lowest = balance + dueCents
    if (lowest < 0) alerts.push({ kind: 'balance', key: `balance:${a.id}:${until}`, accountId: a.id, name: a.name, currency: a.currency, balanceCents: balance, lowestCents: lowest, until, dueCents: -dueCents })
  }
  return alerts
}

function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  return `${date.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
