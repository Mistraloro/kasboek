import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, snapshotEncrypted, type Db } from '@core/database'
import { coreOps, runOp } from '@core/ops'
import * as sync from '@core/sync'
import { findRecurring, setRecurringHidden } from '@core/recurring'

const key = randomBytes(32).toString('hex')
const dir = mkdtempSync(join(tmpdir(), 'kb-sync-'))
let n = 0

function computer(db: Db) {
  const ctx = { db, actor: 'user' as const }
  return async (name: Parameters<typeof runOp>[2], input: unknown) => {
    const r = await runOp(coreOps, ctx, name, input)
    if (!r.ok) throw new Error(r.error.message)
    return r.data as any
  }
}

async function pair() {
  const a = openDatabase(join(dir, `a${++n}.db`), key)
  const opA = computer(a)
  const acc = await opA('accounts.create', { name: 'Current' })
  await opA('transactions.create', { accountId: acc.id, bookingDate: '2026-11-01', amountCents: -1000, description: 'Bakery' })
  sync.enable(a, 'A')
  // B joins from A's snapshot.
  const file = join(dir, `b${n}.db`)
  snapshotEncrypted(a, file)
  const b = openDatabase(file, key)
  return { a, b, opA, opB: computer(b), acc }
}

const exchange = (from: Db, fromId: string, to: Db, toId: string) => sync.apply(to, toId, fromId, sync.flush(from, fromId))
const rows = (db: Db) => db.prepare('SELECT t.description, t.amount_cents, c.name AS cat, t.notes FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.description').all()

describe('sync', () => {
  it('brings new rows, edits and deletions across, with references by uid', async () => {
    const { a, b, opA, opB, acc } = await pair()
    const cats = await opA('categories.list', {})
    const hobby = (await opA('categories.create', { name: 'Hobby', kind: 'expense' })).find((c: any) => c.name === 'Hobby')
    const tx = await opA('transactions.create', { accountId: acc.id, bookingDate: '2026-11-02', amountCents: -2500, description: 'Paint', categoryId: hobby.id })
    await opA('budgets.set', { categoryId: hobby.id, month: '2026-11', amountCents: 5000 })
    let r = exchange(a, 'A', b, 'B')
    expect(r.deferred).toBe(0)
    expect(rows(b)).toEqual(rows(a))
    expect((await opB('budgets.list', { month: '2026-11' })).find((x: any) => x.name === 'Hobby').budgetCents).toBe(5000)

    // B edits and deletes; A gets it.
    const bTx = (await opB('transactions.list', { search: 'Paint' })).items[0]
    await opB('transactions.update', { id: bTx.id, notes: 'acrylic' })
    const bakery = (await opB('transactions.list', { search: 'Bakery' })).items[0]
    await opB('transactions.delete', { ids: [bakery.id] })
    r = exchange(b, 'B', a, 'A')
    expect(rows(a)).toEqual(rows(b))
    expect(rows(a)).toHaveLength(1)
    expect(cats.length).toBeGreaterThan(0)
    void tx
  })

  it('merges different fields of the same row and notes real clashes', async () => {
    const { a, b, opA, opB } = await pair()
    const txA = (await opA('transactions.list', {})).items[0]
    const txB = (await opB('transactions.list', {})).items[0]
    const cats = await opA('categories.list', {})
    const groceries = cats.find((c: any) => c.name === 'Groceries').id
    // Offline on both: A sets a category, B a note → both kept.
    await opA('transactions.update', { id: txA.id, categoryId: groceries })
    await opB('transactions.update', { id: txB.id, notes: 'with Sam' })
    const fromA = sync.flush(a, 'A')
    const fromB = sync.flush(b, 'B')
    sync.apply(b, 'B', 'A', fromA)
    sync.apply(a, 'A', 'B', fromB)
    expect(rows(a)).toEqual(rows(b))
    expect(rows(a)[0]).toMatchObject({ cat: 'Groceries', notes: 'with Sam' })
    expect(sync.listConflicts(a)).toHaveLength(0)

    // Both change the description: the later one wins on both, and both keep a note.
    await opA('transactions.update', { id: txA.id, description: 'Bakery Paul' })
    await new Promise((r) => setTimeout(r, 5))
    await opB('transactions.update', { id: txB.id, description: 'Bakery Lise' })
    const a2 = sync.flush(a, 'A')
    const b2 = sync.flush(b, 'B')
    sync.apply(b, 'B', 'A', a2)
    sync.apply(a, 'A', 'B', b2)
    expect(rows(a)).toEqual(rows(b))
    expect(rows(a)[0]).toMatchObject({ description: 'Bakery Lise' })
    expect(sync.listConflicts(a)).toHaveLength(1)
    expect(sync.listConflicts(b)).toHaveLength(1)
    expect(sync.listConflicts(a)[0]!.summary).toMatch(/Bakery Lise/)
  })

  it('handles the same thing made on two computers and changes that arrive before their references', async () => {
    const { a, b, opA, opB } = await pair()
    await opA('categories.create', { name: 'Pets', kind: 'expense' })
    await opB('categories.create', { name: 'Pets', kind: 'expense' })
    const fromA = sync.flush(a, 'A')
    const fromB = sync.flush(b, 'B')
    sync.apply(b, 'B', 'A', fromA)
    sync.apply(a, 'A', 'B', fromB)
    const names = (db: Db) => (db.prepare("SELECT name FROM categories WHERE name LIKE 'Pets%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(names(a)).toEqual(['Pets', 'Pets (2)'])
    expect(names(b)).toEqual(['Pets', 'Pets (2)'])

    // A new account and its transaction, applied in the wrong order: waits, then lands.
    const acc = await opA('accounts.create', { name: 'Savings' })
    const c1 = sync.flush(a, 'A')
    await opA('transactions.create', { accountId: acc.id, bookingDate: '2026-11-05', amountCents: 9900, description: 'Interest' })
    const c2 = sync.flush(a, 'A')
    expect(sync.apply(b, 'B', 'A', c2).deferred).toBe(1)
    sync.apply(b, 'B', 'A', c1)
    expect((b.prepare("SELECT count(*) AS n FROM transactions WHERE description = 'Interest'").get() as { n: number }).n).toBe(1)
  })

  it('does not echo applied changes back, and does not record anything while off', async () => {
    const { a, b, opA } = await pair()
    await opA('categories.create', { name: 'Books', kind: 'expense' })
    exchange(a, 'A', b, 'B')
    expect(sync.flush(b, 'B')).toEqual([])
    sync.disable(a)
    await opA('categories.create', { name: 'Games', kind: 'expense' })
    expect(sync.flush(a, 'A')).toEqual([])
  })

  it('brings splits, goals, transfer pairs and the bank text across', async () => {
    const { a, b, opA, opB, acc } = await pair()
    const savings = await opA('accounts.create', { name: 'Savings' })
    const cats = await opA('categories.list', {})
    const cat = (n: string) => cats.find((c: any) => c.name === n).id
    const receipt = await opA('transactions.create', { accountId: acc.id, bookingDate: '2026-11-03', amountCents: -10000, description: 'Receipt' })
    await opA('transactions.split', { id: receipt.id, parts: [{ categoryId: cat('Groceries'), amountCents: -7000 }, { categoryId: cat('Shopping'), amountCents: -3000 }] })
    await opA('goals.create', { name: 'Holiday', targetCents: 200000, accountId: savings.id })
    const o = await opA('transactions.create', { accountId: acc.id, bookingDate: '2026-11-04', amountCents: -5000, description: 'To savings' })
    const i = await opA('transactions.create', { accountId: savings.id, bookingDate: '2026-11-04', amountCents: 5000, description: 'From current' })
    await opA('transfers.pair', { pairs: [{ outId: o.id, inId: i.id }] })
    expect(exchange(a, 'A', b, 'B').deferred).toBe(0)
    const bReceipt = (await opB('transactions.list', { search: 'Receipt' })).items[0]
    expect(bReceipt.splitCount).toBe(2)
    expect((await opB('transactions.splits', { id: bReceipt.id })).map((p: any) => [p.categoryName, p.amountCents])).toEqual([['Groceries', -7000], ['Shopping', -3000]])
    expect((await opB('goals.list', {}))[0]).toMatchObject({ name: 'Holiday', accountName: 'Savings' })
    expect((await opB('transactions.list', { search: 'To savings' })).items[0].transferAccount).toBe('Savings')
    expect(b.prepare("SELECT bank_description FROM transactions WHERE description = 'Receipt'").get()).toEqual({ bank_description: 'Receipt' })
  })

  describe('fixed costs marked as not fixed', () => {
    const TODAY = '2026-11-10'
    /** Two computers that both know a monthly payment to "Streamly". */
    async function withFixedCost() {
      const p = await pair()
      for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) await p.opA('transactions.create', { accountId: p.acc.id, bookingDate: `${m}-05`, amountCents: -1200, description: 'Subscription', counterpartyName: 'Streamly' })
      exchange(p.a, 'A', p.b, 'B')
      const itemKey = findRecurring(p.a, TODAY).items[0]!.key
      expect(findRecurring(p.b, TODAY).items.map((i) => i.key)).toEqual([itemKey])
      return { ...p, itemKey }
    }
    const hiddenKeys = (db: Db) => findRecurring(db, TODAY).hidden.map((i) => i.key)

    it('brings the mark to the other computer', async () => {
      const { a, b, itemKey } = await withFixedCost()
      setRecurringHidden(a, itemKey, true, TODAY)
      expect(exchange(a, 'A', b, 'B').deferred).toBe(0)
      expect(hiddenKeys(b)).toEqual([itemKey])
      expect(findRecurring(b, TODAY).items).toEqual([])
    })

    it('can be hidden, shown and hidden again across two computers', async () => {
      const { a, b, itemKey } = await withFixedCost()
      setRecurringHidden(a, itemKey, true, TODAY)
      exchange(a, 'A', b, 'B')
      setRecurringHidden(b, itemKey, false, TODAY)
      exchange(b, 'B', a, 'A')
      expect(hiddenKeys(a)).toEqual([])
      setRecurringHidden(a, itemKey, true, TODAY)
      exchange(a, 'A', b, 'B')
      expect(hiddenKeys(b)).toEqual([itemKey])
      expect(b.prepare('SELECT count(*) AS n FROM recurring_marks').get()).toEqual({ n: 1 })
    })

    it('makes one row when both computers hide the same item', async () => {
      const { a, b, itemKey } = await withFixedCost()
      setRecurringHidden(a, itemKey, true, TODAY)
      setRecurringHidden(b, itemKey, true, TODAY)
      expect(exchange(a, 'A', b, 'B').deferred).toBe(0)
      exchange(b, 'B', a, 'A')
      for (const db of [a, b]) {
        expect(db.prepare('SELECT key, hidden FROM recurring_marks').all()).toEqual([{ key: itemKey, hidden: 1 }])
      }
      expect((a.prepare('SELECT uid FROM recurring_marks').get() as { uid: string }).uid).toBe(itemKey)
    })
  })
})
