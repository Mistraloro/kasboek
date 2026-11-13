import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAmount } from '@shared/amount'
import { openDatabase } from '@core/database'
import { analyze, commit, listBatches, remap, undoBatch, updateRows } from '@core/import'
import { createRule } from '@core/finance'
import { parseCsv } from '@core/csv/read'
import { parseDate, structuredCommunication } from '@core/csv/normalize'

const fixture = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)))
function db() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-csv-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(d.prepare("INSERT INTO accounts (name, bank) VALUES ('Main', 'argenta')").run().lastInsertRowid)
  return { d, acc }
}

describe('parsing helpers', () => {
  it('parses Belgian and international amounts', () => {
    expect(parseAmount('-1.234,56')).toBe(-123456)
    expect(parseAmount('2.850,00')).toBe(285000)
    expect(parseAmount('+3,12')).toBe(312)
    expect(parseAmount('12,50-')).toBe(-1250)
    expect(parseAmount('1,234.56', '.')).toBe(123456)
    expect(parseAmount('€ 1 234,5')).toBe(123450)
    expect(parseAmount('(4,00)')).toBe(-400)
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('1,234')).toBeNull() // ambiguous on its own: refused, not guessed
    expect(parseAmount('1,234', '.')).toBe(123400)
    expect(parseAmount('1.234.567')).toBe(123456700)
  })
  it('parses dates and rejects impossible ones', () => {
    expect(parseDate('03-10-2026', 'DMY')).toBe('2026-10-03')
    expect(parseDate('2026-10-03', 'YMD')).toBe('2026-10-03')
    expect(parseDate('31/02/2026', 'DMY')).toBeNull()
    expect(parseDate('20261003', 'YMD')).toBe('2026-10-03')
  })
  it('validates structured communications', () => {
    expect(structuredCommunication('+++090/9337/55493+++')).toBe('+++090/9337/55493+++')
    expect(structuredCommunication('090933755493')).toBe('+++090/9337/55493+++')
    expect(structuredCommunication('+++090/9337/55494+++')).toBeNull()
  })
  it('handles quotes, doubled quotes and delimiters inside fields', () => {
    expect(parseCsv('a;"b;c";"d ""e"""\n', ';')).toEqual([['a', 'b;c', 'd "e"']])
  })
})

describe('bank files', () => {
  it('Argenta (Windows-1252): detects bank, columns, IBANs and structured communication', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'argenta.csv', bytes: fixture('argenta.csv'), accountId: acc })
    expect(p.layout).toBe('argenta')
    expect(p.encoding).toBe('windows-1252')
    expect(p.stats).toMatchObject({ total: 4, ready: 4, problems: 0 })
    const salary = p.rows.find((r) => r.amountCents === 285000)!
    expect(salary).toMatchObject({ bookingDate: '2026-10-01', counterpartyName: 'ACME NV', counterpartyIban: 'BE71096123456769' })
    expect(p.rows.find((r) => r.counterpartyName === 'ENGIE ELECTRABEL')!.communication).toBe('+++090/9337/55493+++')
    expect(p.rows.some((r) => r.counterpartyName === 'CAFÉ DE ZWAAN')).toBe(true)
  })

  it('Hello bank!: skips refused payments and keeps quoted text intact', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'hb.csv', bytes: fixture('hellobank.csv'), accountId: acc })
    expect(p.layout).toBe('hellobank')
    expect(p.stats).toMatchObject({ total: 4, ready: 3, skipped: 1 })
    expect(p.rows.find((r) => r.amountCents === -125000)!.counterpartyIban).toBe('BE43068200000101')
    expect(p.rows.find((r) => r.amountCents === -1999)!.counterpartyName).toBe('BOL.COM; ONLINE')
  })

  it('Keytrade: finds the header below the info lines', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'kt.csv', bytes: fixture('keytrade.csv'), accountId: acc })
    expect(p.layout).toBe('keytrade')
    expect(p.mapping!.headerRow).toBe(2)
    expect(p.rows.map((r) => r.amountCents)).toEqual([50000, -750, 312])
    expect(p.rows[0]!.description).toContain('STORTING')
  })

  it('generic comma file with debit/credit columns flags broken rows', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'g.csv', bytes: fixture('generic.csv'), accountId: acc })
    expect(p.mapping!.decimal).toBe('.')
    expect(p.rows.map((r) => r.amountCents)).toEqual([-95000, 285000, -1200, null])
    expect(p.stats).toMatchObject({ ready: 2, problems: 2 })
    expect(p.rows[2]!.issues).toContain('date_invalid')
    // Fixing a row by hand makes it importable.
    const fixed = updateRows(d, p.sessionId, [{ index: 2, bookingDate: '2026-10-02' }])
    expect(fixed.stats.ready).toBe(3)
  })
})

describe('commit, duplicates, rules, saved mapping, undo', () => {
  it('imports once, flags the re-import as duplicates, reuses the mapping and can undo', () => {
    const { d, acc } = db()
    const groceries = (d.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id
    createRule(d, { field: 'counterparty', pattern: 'delhaize', categoryId: groceries, applyToExisting: false })

    const p = analyze(d, { fileName: 'a.csv', bytes: fixture('argenta.csv'), accountId: acc })
    expect(p.rows.find((r) => r.counterpartyName === 'DELHAIZE LEUVEN')).toMatchObject({ categoryId: groceries, categorySource: 'rule' })
    const r = commit(d, p.sessionId, true)
    expect(r.imported).toBe(4)

    const again = analyze(d, { fileName: 'a.csv', bytes: fixture('argenta.csv'), accountId: acc })
    expect(again.mappingSource).toBe('saved')
    expect(again.stats).toMatchObject({ ready: 0, duplicates: 4 })

    const inc = updateRows(d, again.sessionId, [{ index: 0, decided: 'include' }])
    expect(inc.stats.ready).toBe(1)

    expect(listBatches(d)[0]!.remaining).toBe(4)
    expect(undoBatch(d, r.batchId).deleted).toBe(4)
    expect((d.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n).toBe(0)
  })

  it('rejects mappings that point at columns that do not exist', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'a.csv', bytes: fixture('argenta.csv'), accountId: acc })
    expect(() => remap(d, p.sessionId, { ...p.mapping!, columns: { ...p.mapping!.columns, amount: 99 } })).toThrow(/doesn’t exist/)
  })
})

describe('generic headers', () => {
  it('maps Payee and Memo', () => {
    const { d, acc } = db()
    const p = analyze(d, { fileName: 'g.csv', bytes: fixture('generic.csv'), accountId: acc })
    expect(p.rows[0]).toMatchObject({ counterpartyName: 'Landlord', description: 'Rent, October' })
  })
})
