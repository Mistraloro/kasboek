import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { coreOps, runOp } from '@core/ops'

async function setup() {
  const ctx = { db: openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-f-')), 'k.db'), randomBytes(32).toString('hex')), actor: 'user' as const }
  const op = async (name: Parameters<typeof runOp>[2], input: unknown) => {
    const r = await runOp(coreOps, ctx, name, input)
    if (!r.ok) throw new Error(r.error.message)
    return r.data as any
  }
  const acc = await op('accounts.create', { name: 'Argenta', bank: 'argenta' })
  const cats = await op('categories.list', {})
  const cat = (n: string) => cats.find((c: any) => c.name === n).id
  return { ctx, op, acc, cat }
}

describe('budgets and summaries', () => {
  it('computes income, spending, refunds, transfers and budget left', async () => {
    const { op, acc, cat } = await setup()
    const tx = (d: string, a: number, desc: string, c?: string) => op('transactions.create', { accountId: acc.id, bookingDate: d, amountCents: a, description: desc, categoryId: c ? cat(c) : null })
    await tx('2026-10-01', 250000, 'Salary', 'Salary')
    await tx('2026-10-03', -8000, 'Delhaize', 'Groceries')
    await tx('2026-10-10', -2000, 'Colruyt', 'Groceries')
    await tx('2026-10-11', 500, 'Refund Colruyt', 'Groceries')
    await tx('2026-10-15', -50000, 'To savings', 'Own transfers')
    await tx('2026-10-20', -1500, 'Unknown shop')
    await tx('2026-09-20', -9999, 'Last month')
    await op('budgets.set', { categoryId: cat('Groceries'), month: '2026-10', amountCents: 30000 })

    const s = await op('summary.month', { month: '2026-10' })
    expect(s.incomeCents).toBe(250500)
    expect(s.spendingCents).toBe(11500) // transfers excluded
    expect(s.budgetedCents).toBe(30000)
    expect(s.leftCents).toBe(30000 - 9500) // refund lowers grocery spending
    expect(s.byCategory[0]).toMatchObject({ name: 'Groceries', cents: 9500 })
    expect(s.uncategorized).toBe(1)
    expect(s.history).toHaveLength(6)
    expect(s.history[5].month).toBe('2026-10')

    expect((await op('budgets.copyPrevious', { month: '2026-11' })).copied).toBe(1)
    await expect(op('budgets.set', { categoryId: cat('Salary'), month: '2026-10', amountCents: 1 })).rejects.toThrow(/spending categories/)

    const accounts = await op('accounts.list', {})
    expect(accounts[0].balanceCents).toBe(250000 - 8000 - 2000 + 500 - 50000 - 1500 - 9999)
  })

  it('rules categorise existing and new transactions; search escapes wildcards', async () => {
    const { op, acc, cat } = await setup()
    await op('transactions.create', { accountId: acc.id, bookingDate: '2026-10-03', amountCents: -800, description: 'Betaling', counterpartyName: 'DELHAIZE BRUSSEL' })
    await op('transactions.create', { accountId: acc.id, bookingDate: '2026-10-04', amountCents: -100, description: '100% fun' })
    const r = await op('rules.create', { field: 'counterparty', pattern: 'delhaize', categoryId: cat('Groceries') })
    expect(r.applied).toBe(1)
    const t = await op('transactions.create', { accountId: acc.id, bookingDate: '2026-10-05', amountCents: -900, description: 'x', counterpartyName: 'Delhaize Gent' })
    expect(t.categoryName).toBe('Groceries')
    expect((await op('transactions.list', { search: '%' })).total).toBe(1)
    expect((await op('transactions.list', { categoryId: 'none' })).total).toBe(1)
    expect((await op('transactions.list', { month: '2026-10', direction: 'out' })).outCents).toBe(1800)
  })
})

describe('migration 3', () => {
  it('turns old bank ids into readable names', async () => {
    const { randomBytes } = await import('node:crypto')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { openDatabase } = await import('@core/database')
    const file = join(mkdtempSync(join(tmpdir(), 'kb-m3-')), 'k.db')
    const key = randomBytes(32).toString('hex')
    const db = openDatabase(file, key)
    db.prepare("INSERT INTO accounts (name, bank) VALUES ('a', 'hellobank'), ('b', 'other')").run()
    db.pragma('user_version = 2')
    db.close()
    const again = openDatabase(file, key)
    expect(again.prepare('SELECT bank FROM accounts ORDER BY name').all()).toEqual([{ bank: 'Hello bank!' }, { bank: '' }])
    again.close()
  })
})
