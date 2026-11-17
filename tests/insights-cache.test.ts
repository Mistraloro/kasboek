import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@core/database'
import { insertTransaction } from '@core/finance'
import { buildFacts, forgetFacts, giveFeedback } from '@core/insights'

const calls = vi.hoisted(() => ({ review: [] as string[], trend: [] as string[] }))
vi.mock('../src/core/review', async (original) => {
  const real = await original<typeof import('../src/core/review')>()
  return {
    ...real,
    monthReview: (db: Parameters<typeof real.monthReview>[0], month: string) => (calls.review.push(month), real.monthReview(db, month)),
    categoryTrend: (...args: Parameters<typeof real.categoryTrend>) => (calls.trend.push(args[1]), real.categoryTrend(...args))
  }
})

// All data here is invented.
const TODAY = '2026-11-10'

function setup() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-cache-')), 'k.db'), randomBytes(32).toString('hex'))
  const account = Number(db.prepare("INSERT INTO accounts (name, kind, currency) VALUES ('Current', 'current', 'EUR')").run().lastInsertRowid)
  const food = Number(db.prepare("INSERT INTO categories (name, kind) VALUES ('Food', 'expense')").run().lastInsertRowid)
  const pay = (date: string, cents: number) => insertTransaction(db, { accountId: account, bookingDate: date, amountCents: cents, description: `Shop ${date}`, counterpartyName: 'Shop', categoryId: food })
  for (const m of ['2026-07', '2026-08', '2026-09']) pay(`${m}-05`, -10000)
  pay('2026-10-05', -30000)
  return { db, pay }
}

beforeEach(() => {
  calls.review.length = 0
  calls.trend.length = 0
})

describe('working out the facts of the Overview', () => {
  it('reads the full review once, and only the category totals for the month before', () => {
    const { db } = setup()
    const facts = buildFacts(db, '2026-11', TODAY)
    expect(facts.map((f) => f.kind)).toContain('category_up')
    expect(calls.review).toEqual(['2026-11'])
    expect(calls.trend).toEqual(['2026-10'])
  })

  it('reuses the review when the month shown is the finished month', () => {
    const { db } = setup()
    expect(buildFacts(db, '2026-10', TODAY).map((f) => f.kind)).toContain('category_up')
    expect(calls.review).toEqual(['2026-10'])
    expect(calls.trend).toEqual([])
  })

  it('keeps the facts until the data changes', () => {
    const { db, pay } = setup()
    const first = buildFacts(db, '2026-11', TODAY)
    expect(buildFacts(db, '2026-11', TODAY)).toEqual(first)
    expect(calls.review).toHaveLength(1)
    // Another month, or another day, is another entry.
    buildFacts(db, '2026-10', TODAY)
    expect(calls.review).toHaveLength(2)
    buildFacts(db, '2026-11', TODAY)
    expect(calls.review).toHaveLength(3)

    buildFacts(db, '2026-11', TODAY)
    expect(calls.review).toHaveLength(3)
    pay('2026-11-02', -90000)
    const changed = buildFacts(db, '2026-11', TODAY)
    expect(calls.review).toHaveLength(4)
    expect(changed).not.toEqual(first)
  })

  it('is worked out again after a data.changed event, and leaves out what was hidden', () => {
    const { db } = setup()
    const first = buildFacts(db, '2026-11', TODAY)
    forgetFacts(db)
    buildFacts(db, '2026-11', TODAY)
    expect(calls.review).toHaveLength(2)
    // A hidden tip is gone from the next answer.
    giveFeedback(db, first[0]!.key, 'dismissed')
    const after = buildFacts(db, '2026-11', TODAY)
    expect(after.map((f) => f.key)).not.toContain(first[0]!.key)
  })
})
