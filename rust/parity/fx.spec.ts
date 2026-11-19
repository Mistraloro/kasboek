// The SQL function fx(cents, from, date, to): same results from the app's installFx (better-sqlite3) and from the Rust
// store on the same database and the same rates, including result types and NULLs. Invented rates.
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { KEY_HEX, cli, tempDir } from './helpers'

const tmp = tempDir()
afterAll(() => tmp.remove())

const RATES: [string, string, number, 'ecb' | 'manual'][] = [
  ['USD', '2025-01-01', 1.1, 'ecb'],
  ['USD', '2025-01-10', 1.2, 'ecb'],
  ['USD', '2025-01-10', 1.25, 'manual'], // a manual rate wins over the ECB rate of the same day
  ['USD', '2025-06-30', 1.07, 'ecb'],
  ['JPY', '2025-02-03', 160.55, 'ecb'],
  ['JPY', '2025-02-10', 158.1, 'ecb'],
  ['GBP', '2024-12-31', 0.8321, 'ecb'],
  ['CHF', '2025-03-03', 0.9613, 'manual']
]

describe('fx()', () => {
  it('gives the same answers in TS and Rust, with the same types', () => {
    const f = join(tmp.dir, 'fx.db')
    const db = openDatabase(f, KEY_HEX)
    const ins = db.prepare('INSERT INTO fx_rates (currency, date, per_eur, source) VALUES (?,?,?,?)')
    for (const r of RATES) ins.run(...r)
    db.close()

    const currencies = ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'SEK', 'usd', '']
    const dates = ['2024-01-01', '2024-12-31', '2025-01-01', '2025-01-09', '2025-01-10', '2025-02-05', '2025-06-30', '2026-01-01', '2025-1-1', 'not a date']
    const amounts: unknown[] = [0, 1, -1, 5, 100, 1250, -1250, 99_999_999, 12_345_678_901, -2500, 1_000_000_007, 7, 3, 1.5, 2.5, -2.5, 0.49999999999999994]
    const cases: unknown[][] = []
    let s = 987654321
    // mulberry32: good enough to spread the cases over all the inputs.
    const next = (n: number): number => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
    }
    for (let i = 0; i < 400; i++) cases.push([amounts[next(amounts.length)], currencies[next(currencies.length)], dates[next(dates.length)], currencies[next(currencies.length)]])
    // Arguments that are not numbers or not text: NULL cents, text cents, an integer in a text position.
    cases.push([null, 'EUR', '2025-01-01', 'USD'], ['1000', 'EUR', '2025-01-01', 'USD'], [1000, 'EUR', '2025-01-01', null], [1000, 5, '2025-01-01', 5], [1000, 'USD', 20250101, 'EUR'])

    const ts = openDatabase(f, KEY_HEX)
    const expected = cases.map((c) => {
      const row = ts.prepare('SELECT typeof(fx(?,?,?,?)) AS type, fx(?,?,?,?) AS value').get(...c, ...c) as { type: string; value: unknown }
      return { type: row.type, value: row.value }
    })
    ts.close()
    const actual = cli<{ type: string; value: unknown }[]>(['db-fx', f, KEY_HEX], cases)
    expect(actual.length).toBe(cases.length)
    actual.forEach((got, i) => expect(got, JSON.stringify(cases[i])).toEqual(expected[i]))
    // The set was not trivial: conversions, NULLs and same-currency pass-through all occur.
    expect(new Set(expected.map((e) => e.type))).toEqual(new Set(['real', 'null']))
    expect(expected.filter((e) => e.type === 'real').length).toBeGreaterThan(60)
    expect(expected.filter((e) => e.type === 'null').length).toBeGreaterThan(60)
  })
})
