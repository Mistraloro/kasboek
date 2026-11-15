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
