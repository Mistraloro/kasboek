import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { insertTransaction, listTransactions, monthSummary } from '@core/finance'
import { findTransfers, pairTransfers, unpairTransfer } from '@core/transfers'

function db() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-feat-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = (name: string, iban: string | null = null) => Number(d.prepare('INSERT INTO accounts (name, iban) VALUES (?, ?)').run(name, iban).lastInsertRowid)
  return { d, acc }
}
const cat = (d: ReturnType<typeof db>['d'], name: string) => (d.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id
const tx = (d: ReturnType<typeof db>['d'], accountId: number, date: string, cents: number, extra: Record<string, unknown> = {}) =>
  insertTransaction(d, { accountId, bookingDate: date, amountCents: cents, description: `tx ${date} ${cents}`, ...extra })

describe('transfers between own accounts (#28)', () => {
  it('finds pairs, surest first, pairs them as transfers and can separate them', () => {
    const { d, acc } = db()
    const current = acc('Current', 'BE68539007547034')
    const savings = acc('Savings', 'BE71096123456769')
    const out1 = tx(d, current, '2026-10-01', -50000, { counterpartyIban: 'BE71096123456769' })
    const in1 = tx(d, savings, '2026-10-02', 50000)
    // Same amount, no account number: only a suggestion.
    const out2 = tx(d, current, '2026-10-10', -2000)
    const in2 = tx(d, savings, '2026-10-12', 2000)
    // Too far apart.
    tx(d, current, '2026-10-20', -700)
    tx(d, savings, '2026-10-30', 700)
    const found = findTransfers(d)
    expect(found.map((f) => [f.outId, f.inId, f.confidence])).toEqual([[out1, in1, 'iban'], [out2, in2, 'amount']])
    const before = monthSummary(d, '2026-10')
    expect(pairTransfers(d, found)).toEqual({ paired: 2 })
    const after = monthSummary(d, '2026-10')
    // Transfers count as neither income nor spending.
    expect(before.spendingCents - after.spendingCents).toBe(52000)
    expect(before.incomeCents - after.incomeCents).toBe(52000)
    const items = listTransactions(d, { limit: 10, offset: 0 }).items
    expect(items.find((t) => t.id === out1)?.transferAccount).toBe('Savings')
    expect(findTransfers(d)).toEqual([])
    unpairTransfer(d, in2)
    expect(listTransactions(d, { limit: 10, offset: 0 }).items.find((t) => t.id === out2)?.transferAccount).toBeNull()
  })

  it('keeps a transfer category one half already has', () => {
    const { d, acc } = db()
    const a = acc('A')
    const b = acc('B')
    const o = tx(d, a, '2026-10-01', -100, { categoryId: cat(d, 'Savings') })
    const i = tx(d, b, '2026-10-01', 100)
    pairTransfers(d, [{ outId: o, inId: i }])
    const cats = (d.prepare('SELECT category_id FROM transactions ORDER BY id').all() as { category_id: number }[]).map((r) => r.category_id)
    expect(cats).toEqual([cat(d, 'Savings'), cat(d, 'Savings')])
  })
})

describe('refunds and splits (#29)', () => {
  it('counts a split’s parts in summaries and budgets, and checks the parts add up', async () => {
    const { setSplits, listSplits, setBudget } = await import('@core/finance')
    const { d, acc } = db()
    const a = acc('Current')
    const groceries = cat(d, 'Groceries')
    const shopping = cat(d, 'Shopping')
    const receipt = tx(d, a, '2026-10-05', -10000, { categoryId: groceries })
    tx(d, a, '2026-10-06', 2500, { categoryId: cat(d, 'Subscriptions') }) // a Netflix share paid back
    tx(d, a, '2026-10-07', -5000, { categoryId: cat(d, 'Subscriptions') })
    setBudget(d, { categoryId: groceries, month: '2026-10', amountCents: 20000 })
    expect(() => setSplits(d, receipt, [{ categoryId: groceries, amountCents: -7000 }, { categoryId: shopping, amountCents: -2000 }])).toThrow(/add up/)
    setSplits(d, receipt, [{ categoryId: groceries, amountCents: -7000 }, { categoryId: shopping, amountCents: -3000, note: 'towels' }])
    expect(listSplits(d, receipt)).toHaveLength(2)
    const s = monthSummary(d, '2026-10')
    const by = Object.fromEntries(s.byCategory.map((c) => [c.name, c.cents]))
    expect(by).toMatchObject({ Groceries: 7000, Shopping: 3000, Subscriptions: 2500 })
    // The share paid back lowers spending; it isn't income.
    expect(s.incomeCents).toBe(0)
    expect(s.spendingCents).toBe(12500)
    expect(s.leftCents).toBe(13000)
    setSplits(d, receipt, [])
    expect(Object.fromEntries(monthSummary(d, '2026-10').byCategory.map((c) => [c.name, c.cents]))).toMatchObject({ Groceries: 10000 })
  })
})

describe('subscriptions and fixed costs (#30)', () => {
  it('finds what comes back, what is due, price changes and late payments', async () => {
    const { findRecurring } = await import('@core/recurring')
    const { d, acc } = db()
    const a = acc('Current')
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
    months.forEach((m, i) => tx(d, a, `${m}-05`, i === 5 ? -1599 : -1399, { counterpartyName: 'Netflix' }))
    months.forEach((m) => tx(d, a, `${m}-01`, -95000, { counterpartyName: 'Landlord' }))
    months.forEach((m) => tx(d, a, `${m}-25`, 250000, { counterpartyName: 'Employer' }))
    // Energy: monthly until August, then nothing.
    ;['2026-05', '2026-06', '2026-07', '2026-08'].forEach((m) => tx(d, a, `${m}-15`, -12000, { counterpartyName: 'Engie' }))
    tx(d, a, '2025-11-02', -45000, { counterpartyName: 'Insurer' })
    tx(d, a, '2026-11-02', -46000, { counterpartyName: 'Insurer' })
    // Not regular.
    tx(d, a, '2026-06-03', -2000, { counterpartyName: 'Bakery' })
    tx(d, a, '2026-09-20', -3500, { counterpartyName: 'Bakery' })
    const r = findRecurring(d, '2026-11-10')
    const by = Object.fromEntries(r.items.map((i) => [i.name, i]))
    expect(Object.keys(by).sort()).toEqual(['Employer', 'Engie', 'Insurer', 'Landlord', 'Netflix'])
    // Five days past its date: still within the grace days, so due rather than late.
    expect(by['Netflix']).toMatchObject({ frequency: 'monthly', nextDate: '2026-11-05', status: 'due', priceChangeCents: -200, typicalCents: -1599 })
    expect(by['Landlord']).toMatchObject({ status: 'late' })
    expect(by['Employer']).toMatchObject({ direction: 'in', nextDate: '2026-11-25', status: 'due' })
    expect(by['Insurer']).toMatchObject({ frequency: 'yearly', status: 'paid', monthlyCents: -3833 })
    expect(r.dueThisMonthCents).toBe(1599 + 95000 + 12000)
    expect(by['Engie']!.status).toBe('late')
    expect(r.monthlyOutCents).toBe(95000 + 1599 + 12000 + 3833)
  })
})

describe('monthly review (#31)', () => {
  it('compares with the three months before, lists budgets over and payments that stand out', async () => {
    const { monthReview } = await import('@core/review')
    const { setBudget } = await import('@core/finance')
    const { d, acc } = db()
    const a = acc('Current')
    const groceries = cat(d, 'Groceries')
    for (const m of ['2026-07', '2026-08', '2026-09']) {
      tx(d, a, `${m}-03`, -30000, { categoryId: groceries, counterpartyName: 'Delhaize' })
      tx(d, a, `${m}-10`, -1500, { counterpartyName: 'Garage' })
    }
    tx(d, a, '2026-10-03', -45000, { categoryId: groceries, counterpartyName: 'Delhaize' })
    tx(d, a, '2026-10-10', -9000, { counterpartyName: 'Garage' }) // far above the usual 15.00
    tx(d, a, '2026-10-20', -60000, { counterpartyName: 'New laptop shop' }) // a large first payment
    setBudget(d, { categoryId: groceries, month: '2026-10', amountCents: 40000 })
    const r = monthReview(d, '2026-10')
    expect(r.averageSpendingCents).toBe(31500)
    expect(r.categories.find((c) => c.name === 'Groceries')).toMatchObject({ cents: 45000, averageCents: 30000, changeCents: 15000 })
    expect(r.overBudget).toEqual([{ categoryId: groceries, name: 'Groceries', budgetCents: 40000, spentCents: 45000 }])
    expect(r.unusual.map((u) => [u.name, u.reason])).toEqual([['New laptop shop', 'new'], ['Garage', 'higher']])
  })
})

describe('warnings (#32)', () => {
  it('warns about budgets at 80% and 100%, and a balance going below zero before payday', async () => {
    const { listAlerts } = await import('@core/alerts')
    const { setBudget } = await import('@core/finance')
    const { setBankBalance } = await import('@core/balance')
    const { d, acc } = db()
    const a = acc('Current')
    d.prepare("UPDATE accounts SET kind = 'current'").run()
    setBudget(d, { categoryId: cat(d, 'Groceries'), month: '2026-11', amountCents: 10000 })
    setBudget(d, { categoryId: cat(d, 'Eating out'), month: '2026-11', amountCents: 5000 })
    tx(d, a, '2026-11-03', -8500, { categoryId: cat(d, 'Groceries') })
    tx(d, a, '2026-11-04', -6000, { categoryId: cat(d, 'Eating out') })
    // Salary on the 25th; rent on the 20th.
    for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      tx(d, a, `${m}-25`, 200000, { counterpartyName: 'Employer' })
      tx(d, a, `${m}-20`, -90000, { counterpartyName: 'Landlord' })
    }
    setBankBalance(d, { accountId: a, date: '2026-11-10', balanceCents: 50000 }, '2026-11-10')
    const alerts = listAlerts(d, '2026-11-10')
    const budget = Object.fromEntries(alerts.flatMap((x) => (x.kind === 'budget' ? [[x.name, x.level]] : [])))
    expect(budget).toEqual({ Groceries: 'near', 'Eating out': 'over' })
    const bal = alerts.find((x) => x.kind === 'balance')
    expect(bal).toMatchObject({ kind: 'balance', until: '2026-11-25', balanceCents: 50000, dueCents: 90000, lowestCents: -40000 })
  })
})

describe('savings goals (#33)', () => {
  it('tracks an account or an amount by hand, and says what to put aside per month', async () => {
    const { createGoal, listGoals, updateGoal } = await import('@core/goals')
    const { d, acc } = db()
    const savings = acc('Savings')
    tx(d, savings, '2026-10-01', 50000)
    createGoal(d, { name: 'Holiday', targetCents: 200000, targetDate: '2027-05-15', accountId: savings })
    createGoal(d, { name: 'Buffer', targetCents: 100000, savedCents: 100000 })
    const [holiday, buffer] = listGoals(d, '2026-11-15')
    expect(holiday).toMatchObject({ name: 'Holiday', currentCents: 50000, remainingCents: 150000, perMonthCents: 25000, accountName: 'Savings' })
    expect(buffer).toMatchObject({ reached: true, perMonthCents: null })
    updateGoal(d, { id: holiday!.id, accountId: null, savedCents: 10000 })
    expect(listGoals(d, '2026-11-15')[0]).toMatchObject({ currentCents: 10000, accountId: null })
    expect(listGoals(d, '2027-06-01')[0]).toMatchObject({ overdue: true, perMonthCents: null })
  })
})
