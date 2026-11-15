/** Savings goals: an amount by a date, tracked by an account's balance or kept by hand. */
import { localToday } from '@shared/month'
import type { Goal } from '@shared/types'
import { currentBalance } from './balance'
import type { Db } from './database'
import { AppError } from './errors'
import { convert } from './fx'
import { getSettings } from './settings'

interface GoalRow {
  id: number
  name: string
  target_cents: number
  target_date: string | null
  account_id: number | null
  account_name: string | null
  account_currency: string | null
  saved_cents: number | null
  archived: number
}

/** Whole months from today to the date, at least 1. */
function monthsUntil(today: string, date: string): number {
  const [y1, m1, d1] = today.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = date.split('-').map(Number) as [number, number, number]
  const months = (y2 - y1) * 12 + (m2 - m1) + (d2 >= d1 ? 0 : -1)
  return Math.max(1, months)
}

export function listGoals(db: Db, today = localToday()): Goal[] {
  const main = getSettings(db).currency
  const rows = db
    .prepare(
      `SELECT g.*, a.name AS account_name, a.currency AS account_currency FROM goals g LEFT JOIN accounts a ON a.id = g.account_id
       ORDER BY g.archived, coalesce(g.target_date, '9999'), g.id`
    )
    .all() as GoalRow[]
  return rows.map((r) => {
    // In the main currency: an account in another currency is converted at today's rate.
    const current = r.account_id !== null ? (convert(db, currentBalance(db, r.account_id), r.account_currency ?? main, today, main) ?? 0) : (r.saved_cents ?? 0)
    const remaining = Math.max(0, r.target_cents - current)
    const overdue = !!r.target_date && r.target_date < today
    const perMonth = r.target_date && remaining > 0 && !overdue ? Math.ceil(remaining / monthsUntil(today, r.target_date)) : null
    return {
      id: r.id,
      name: r.name,
      targetCents: r.target_cents,
      targetDate: r.target_date,
      accountId: r.account_id,
      accountName: r.account_name,
      savedCents: r.saved_cents,
      currentCents: current,
      remainingCents: remaining,
      reached: remaining === 0,
      perMonthCents: perMonth,
      overdue: overdue && remaining > 0,
      archived: r.archived === 1
    }
  })
}

type GoalInput = { name: string; targetCents: number; targetDate?: string | null; accountId?: number | null; savedCents?: number | null }

function check(db: Db, g: Partial<GoalInput>): void {
  if (g.accountId != null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(g.accountId)) throw new AppError('accounts.not_found', 'Account not found.')
}

export function createGoal(db: Db, g: GoalInput): Goal[] {
  check(db, g)
  db.prepare('INSERT INTO goals (name, target_cents, target_date, account_id, saved_cents) VALUES (?, ?, ?, ?, ?)').run(
    g.name.trim(),
    g.targetCents,
    g.targetDate ?? null,
    g.accountId ?? null,
    g.accountId != null ? null : (g.savedCents ?? 0)
  )
  return listGoals(db)
}

export function updateGoal(db: Db, g: Partial<GoalInput> & { id: number; archived?: boolean }): Goal[] {
  const old = db.prepare('SELECT * FROM goals WHERE id = ?').get(g.id) as GoalRow | undefined
  if (!old) throw new AppError('goals.not_found', 'That goal no longer exists.')
  check(db, g)
  const accountId = g.accountId !== undefined ? g.accountId : old.account_id
  db.prepare('UPDATE goals SET name = ?, target_cents = ?, target_date = ?, account_id = ?, saved_cents = ?, archived = ? WHERE id = ?').run(
    g.name?.trim() ?? old.name,
    g.targetCents ?? old.target_cents,
    g.targetDate !== undefined ? g.targetDate : old.target_date,
    accountId,
    accountId != null ? null : g.savedCents !== undefined ? g.savedCents : (old.saved_cents ?? 0),
    g.archived !== undefined ? Number(g.archived) : old.archived,
    g.id
  )
  return listGoals(db)
}

export function deleteGoal(db: Db, id: number): Goal[] {
  db.prepare('DELETE FROM goals WHERE id = ?').run(id)
  return listGoals(db)
}
