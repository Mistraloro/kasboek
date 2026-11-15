import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { balanceOn, currentBalance, listBankBalances, setBankBalance } from '@core/balance'
import { accountBalances, insertTransaction } from '@core/finance'
import { analyze, commit, fileBalance, remap } from '@core/import'
import { netWorth } from '@core/wealth'

function db(kind = 'current') {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-bal-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(d.prepare('INSERT INTO accounts (name, kind) VALUES (?, ?)').run('Main', kind).lastInsertRowid)
  return { d, acc }
}
const tx = (d: ReturnType<typeof db>['d'], acc: number, date: string, cents: number) => insertTransaction(d, { accountId: acc, bookingDate: date, amountCents: cents, description: `tx ${date}` })

describe('bank balances', () => {
  it('counts the balance from what the bank showed, before and after that day', () => {
    const { d, acc } = db()
    tx(d, acc, '2026-10-01', -1000)
    tx(d, acc, '2026-10-05', 50000)
    tx(d, acc, '2026-10-10', -2000)
    // The bank showed 1,000.00 at the end of 5 October.
    const r = setBankBalance(d, { accountId: acc, date: '2026-10-05', balanceCents: 100000 }, '2026-11-14')
    expect(r.differenceCents).toBeNull() // nothing to compare with yet
    expect(balanceOn(d, acc, '2026-10-05').cents).toBe(100000)
    expect(balanceOn(d, acc, '2026-10-10').cents).toBe(98000)
    // Before the recorded balance: worked back from it, so the start needn't be known.
    expect(balanceOn(d, acc, '2026-10-04').cents).toBe(50000)
    expect(balanceOn(d, acc, '2026-09-30').cents).toBe(51000)
    expect(currentBalance(d, acc)).toBe(98000)
    expect(accountBalances(d).get(acc)?.balance).toBe(98000)
    // Importing older history later doesn't move today's balance.
    tx(d, acc, '2026-09-15', -30000)
    expect(currentBalance(d, acc)).toBe(98000)
    expect(balanceOn(d, acc, '2026-09-14').cents).toBe(81000)
  })

  it('shows a difference when a transaction is missing, and none once it is there', () => {
    const { d, acc } = db()
    tx(d, acc, '2026-10-01', -1000)
    setBankBalance(d, { accountId: acc, date: '2026-10-01', balanceCents: 20000 }, '2026-11-14')
    tx(d, acc, '2026-10-20', -5000)
    // The bank also booked a 40.00 payment Kasboek doesn't have.
    const r = setBankBalance(d, { accountId: acc, date: '2026-10-31', balanceCents: 11000 }, '2026-11-14')
    expect(r).toMatchObject({ expectedCents: 15000, differenceCents: -4000 })
    expect(listBankBalances(d, acc)[0]).toMatchObject({ date: '2026-10-31', differenceCents: -4000, since: '2026-10-01' })
    tx(d, acc, '2026-10-25', -4000)
    expect(listBankBalances(d, acc)[0]!.differenceCents).toBe(0)
  })

  it('refuses a balance in the future, and on an investment account', () => {
    const { d, acc } = db()
    expect(() => setBankBalance(d, { accountId: acc, date: '2026-12-01', balanceCents: 1 }, '2026-11-14')).toThrow(/today or an earlier day/)
    // An investment has a value (valuations), not a bank balance.
    const inv = db('investment')
    expect(() => setBankBalance(inv.d, { accountId: inv.acc, date: '2026-10-01', balanceCents: 100000 }, '2026-11-14')).toThrow(/investment account has a value/)
  })

  it('net worth before the first recorded balance follows it too', () => {
    const { d, acc } = db()
    tx(d, acc, '2026-09-10', -1000)
    tx(d, acc, '2026-10-10', -1000)
    setBankBalance(d, { accountId: acc, date: '2026-10-31', balanceCents: 5000 }, '2026-11-14')
    const nw = netWorth(d, { months: 3 }, '2026-11-14')
    expect(nw.history.map((h) => h.cents)).toEqual([6000, 5000, 5000])
  })
})

describe('balance from a CSV', () => {
  it('takes the balance after the last transaction of the last day, in either order', () => {
    const rows = [
      { bookingDate: '2026-11-02', balanceCents: 300 },
      { bookingDate: '2026-11-02', balanceCents: 250 },
      { bookingDate: '2026-11-01', balanceCents: 400 }
    ]
    expect(fileBalance(rows)).toEqual({ date: '2026-11-02', cents: 300 })
    expect(fileBalance([...rows].reverse())).toEqual({ date: '2026-11-02', cents: 300 })
    expect(fileBalance([{ bookingDate: '2026-11-01', balanceCents: null }])).toBeNull()
  })

  it('records it on import and asks otherwise', () => {
    const { d, acc } = db()
    const file = new TextEncoder().encode(['Datum;Omschrijving;Bedrag;Saldo', '2026-11-01;Bakker;-3,00;97,00', '2026-11-02;Loon;100,00;197,00'].join('\n'))
    const p = analyze(d, { fileName: 'a.csv', bytes: file, accountId: acc })
    expect(p.mapping?.columns.balance).toBe(3)
    const r = commit(d, p.sessionId, false)
    expect(r).toMatchObject({ lastDate: '2026-11-02', balanceOnLastDate: 19700, askBalance: false, bankBalance: { date: '2026-11-02', balanceCents: 19700 } })
    expect(currentBalance(d, acc)).toBe(19700)

    const other = db()
    const q = analyze(other.d, { fileName: 'b.csv', bytes: new TextEncoder().encode('Datum;Omschrijving;Bedrag\n2026-11-01;Bakker;-3,00'), accountId: other.acc })
    const mapped = remap(other.d, q.sessionId, q.mapping!)
    expect(commit(other.d, mapped.sessionId, false)).toMatchObject({ lastDate: '2026-11-01', askBalance: true, bankBalance: null })
  })
})
