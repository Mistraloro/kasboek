import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listAlerts } from '@core/alerts'
import { openDatabase } from '@core/database'
import { insertTransaction } from '@core/finance'
import { buildFacts } from '@core/insights'
import { findRecurring, setRecurringHidden } from '@core/recurring'

// All data here is invented.
const TODAY = '2026-11-10'
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10']

function setup() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-rec-')), 'k.db'), randomBytes(32).toString('hex'))
  const account = Number(db.prepare("INSERT INTO accounts (name, kind) VALUES ('Current', 'current')").run().lastInsertRowid)
  for (const m of MONTHS) {
    insertTransaction(db, { accountId: account, bookingDate: `${m}-05`, amountCents: -1200, description: `Streamly ${m}`, counterpartyName: 'Streamly' })
    insertTransaction(db, { accountId: account, bookingDate: `${m}-20`, amountCents: -90000, description: `Flat Owner ${m}`, counterpartyName: 'Flat Owner' })
  }
  // Counts how often the 430-day scan of payments runs.
  const prepare = db.prepare.bind(db)
  let scans = 0
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('a.name AS account_name')) scans++
    return prepare(sql)
  }) as typeof db.prepare)
  return { db, scans: () => scans }
}

describe('finding fixed costs', () => {
  it('scans the payments once for everything that asks in one refresh, with the same results', () => {
    const { db, scans } = setup()
    const first = findRecurring(db, TODAY)
    listAlerts(db, TODAY)
    buildFacts(db, '2026-11', TODAY)
    expect(findRecurring(db, TODAY)).toEqual(first)
    expect(scans()).toBe(1)
    expect(first.items.map((i) => i.name)).toEqual(['Flat Owner', 'Streamly'])
  })

  it('scans again for another day, and when anything in the data changed (a hidden mark shows at once)', () => {
    const { db, scans } = setup()
    const first = findRecurring(db, TODAY)
    findRecurring(db, '2026-11-11')
    expect(scans()).toBe(2)
    const hidden = setRecurringHidden(db, first.items[0]!.key, true, TODAY)
    expect(hidden.hidden.map((i) => i.name)).toEqual(['Flat Owner'])
    expect(findRecurring(db, TODAY)).toEqual(hidden)
    expect(findRecurring(db, TODAY).items.map((i) => i.name)).toEqual(['Streamly'])
  })
})
