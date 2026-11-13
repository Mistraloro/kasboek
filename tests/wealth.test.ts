import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { parseEcbCsv, storeEcbRates } from '@core/fx'
import { coreOps, runOp } from '@core/ops'
import { netWorth } from '@core/wealth'

async function setup() {
  const ctx = { db: openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-w-')), 'k.db'), randomBytes(32).toString('hex')), actor: 'user' as const }
  const op = async (name: Parameters<typeof runOp>[2], input: unknown) => {
    const r = await runOp(coreOps, ctx, name, input)
    if (!r.ok) throw new Error(r.error.message)
    return r.data as any
  }
  return { ctx, op }
}

describe('net worth and investments', () => {
  it('values accounts from transactions or recorded values, with gains and liabilities', async () => {
    const { ctx, op } = await setup()
    const current = await op('accounts.create', { name: 'Current', openingBalanceCents: 100000 })
    const broker = await op('accounts.create', { name: 'Broker', kind: 'investment' })
    const card = await op('accounts.create', { name: 'Card', kind: 'credit_card' })
    expect(broker.kind).toBe('investment')
    await op('transactions.create', { accountId: current.id, bookingDate: '2026-01-10', amountCents: -50000, description: 'To broker' })
    await op('transactions.create', { accountId: broker.id, bookingDate: '2026-01-10', amountCents: 50000, description: 'Deposit' })
    await op('transactions.create', { accountId: card.id, bookingDate: '2026-02-03', amountCents: -12000, description: 'Shop' })
    // Portfolio worth 55,000 at the end of January; another 10,000 deposited in March.
    await op('valuations.set', { accountId: broker.id, date: '2026-01-31', valueCents: 55000 })
    await op('transactions.create', { accountId: broker.id, bookingDate: '2026-03-05', amountCents: 10000, description: 'Deposit' })

    const nw = netWorth(ctx.db, { months: 0 }, '2026-03-15')
    const b = nw.accounts.find((a) => a.id === broker.id)!
    expect(b.valueCents).toBe(65000)
    expect(b.investedCents).toBe(60000)
    expect(b.gainCents).toBe(5000)
    expect(nw.assetsCents).toBe(50000 + 65000)
    expect(nw.liabilitiesCents).toBe(-12000)
    expect(nw.totalCents).toBe(103000)
    expect(nw.history.map((h) => h.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    // January end: 50,000 current + 55,000 portfolio; February adds the card debt.
    expect(nw.history.map((h) => h.cents)).toEqual([105000, 93000, 103000])
  })

  it('converts other currencies at each month-end rate', async () => {
    const { ctx, op } = await setup()
    const usd = await op('accounts.create', { name: 'USD', currency: 'USD', openingBalanceCents: 0 })
    await op('transactions.create', { accountId: usd.id, bookingDate: '2026-01-05', amountCents: 110000, description: 'In' })
    storeEcbRates(ctx.db, parseEcbCsv('Date,USD,\n2026-02-27,1.2000,\n2026-01-30,1.1000,\n', new Set(['USD'])))
    const nw = netWorth(ctx.db, { months: 0 }, '2026-02-28')
    expect(nw.history.map((h) => h.cents)).toEqual([100000, 91667])
  })
})

describe('year view', () => {
  it('sums per month and per category, without transfers', async () => {
    const { op } = await setup()
    const acc = await op('accounts.create', { name: 'Current' })
    const cats = await op('categories.list', {})
    const cat = (n: string) => cats.find((c: any) => c.name === n).id
    const tx = (d: string, a: number, c?: string) => op('transactions.create', { accountId: acc.id, bookingDate: d, amountCents: a, description: 'x', categoryId: c ? cat(c) : null })
    await tx('2026-01-01', 250000, 'Salary')
    await tx('2026-01-05', -8000, 'Groceries')
    await tx('2026-01-06', 1000, 'Groceries')
    await tx('2026-03-05', -9000, 'Groceries')
    await tx('2026-03-07', -40000, 'Own transfers')
    await tx('2025-12-20', -5000, 'Groceries')
    const y = await op('summary.year', { year: 2026 })
    expect(y.incomeCents).toBe(251000)
    expect(y.spendingCents).toBe(17000)
    expect(y.months[0]).toMatchObject({ month: '2026-01', incomeCents: 251000, spendingCents: 8000 })
    const g = y.categories.find((c: any) => c.name === 'Groceries')
    expect(g.months[0]).toBe(7000)
    expect(g.months[2]).toBe(9000)
    expect(g.totalCents).toBe(16000)
    expect(y.categories[0].kind).toBe('income')
    expect(y.categories.some((c: any) => c.name === 'Own transfers')).toBe(false)
    expect(y.years.map((r: any) => r.year)).toEqual([2025, 2026])
  })
})

describe('year view, uncategorised', () => {
  it('lists uncategorised money in under income and money out under spending', async () => {
    const { op } = await setup()
    const acc = await op('accounts.create', { name: 'Current' })
    await op('transactions.create', { accountId: acc.id, bookingDate: '2026-02-01', amountCents: 30000, description: 'in' })
    await op('transactions.create', { accountId: acc.id, bookingDate: '2026-02-02', amountCents: -2000, description: 'out' })
    const y = await op('summary.year', { year: 2026 })
    expect(y.categories.map((c: any) => [c.kind, c.categoryId, c.totalCents])).toEqual([['income', null, 30000], ['expense', null, 2000]])
  })
})
