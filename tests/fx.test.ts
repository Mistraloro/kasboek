import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { convert, parseEcbCsv, storeEcbRates } from '@core/fx'
import { coreOps, runOp } from '@core/ops'
import { readZipEntry } from '@core/unzip'

async function setup() {
  const ctx = { db: openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-fx-')), 'k.db'), randomBytes(32).toString('hex')), actor: 'user' as const }
  const op = async (name: Parameters<typeof runOp>[2], input: unknown) => {
    const r = await runOp(coreOps, ctx, name, input)
    if (!r.ok) throw new Error(r.error.message)
    return r.data as any
  }
  return { ctx, op }
}

/** A one-file ZIP, as the ECB serves it. */
function zipOf(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content))
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const cdStart = local.length + nameBuf.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBuf.length, 12)
  end.writeUInt32LE(cdStart, 16)
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end])
}

const ECB = `Date,USD,JPY,GBP,XYZ,\n2026-11-12,1.0800,160.10,0.8600,N/A,\n2026-11-11,1.0700,159.00,0.8500,N/A,\n2026-10-01,1.1000,158.00,0.8400,N/A,\n`

describe('currencies', () => {
  it('reads the ECB file from its ZIP and keeps only currencies in use', () => {
    const csv = readZipEntry(zipOf('eurofxref-hist.csv', ECB), (n) => n.endsWith('.csv'))!.toString()
    const rows = parseEcbCsv(csv, new Set(['USD', 'GBP']))
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ date: '2026-11-12', currency: 'USD', perEur: 1.08 })
  })

  it('converts at the rate of the transaction date, through the euro', async () => {
    const { ctx } = await setup()
    storeEcbRates(ctx.db, parseEcbCsv(ECB, new Set(['USD', 'GBP'])))
    expect(convert(ctx.db, 10800, 'USD', '2026-11-12', 'EUR')).toBe(10000)
    // A weekend uses the last rate before it; before the first rate, the first rate.
    expect(convert(ctx.db, 11000, 'USD', '2026-10-04', 'EUR')).toBe(10000)
    expect(convert(ctx.db, 11000, 'USD', '2020-01-01', 'EUR')).toBe(10000)
    // USD to GBP on 2026-11-12: 100 USD / 1.08 * 0.86
    expect(convert(ctx.db, 10000, 'USD', '2026-11-12', 'GBP')).toBe(7963)
    expect(convert(ctx.db, 10000, 'CHF', '2026-11-12', 'EUR')).toBeNull()
  })

  it('totals in the main currency, balances in the account currency, manual rates win', async () => {
    const { ctx, op } = await setup()
    const eur = await op('accounts.create', { name: 'Current', openingBalanceCents: 100000 })
    const usd = await op('accounts.create', { name: 'US account', currency: 'usd', openingBalanceCents: 0 })
    expect(usd.currency).toBe('USD')
    await expect(runOp(coreOps, ctx, 'accounts.create', { name: 'X', currency: 'ABC' })).resolves.toMatchObject({ ok: false })
    const cats = await op('categories.list', {})
    const groceries = cats.find((c: any) => c.name === 'Groceries').id
    await op('transactions.create', { accountId: eur.id, bookingDate: '2026-11-12', amountCents: -5000, description: 'Shop', categoryId: groceries })
    const t = await op('transactions.create', { accountId: usd.id, bookingDate: '2026-11-12', amountCents: -10800, description: 'Diner', categoryId: groceries })
    expect(t.currency).toBe('USD')

    // No USD rate yet: left out of totals and reported.
    let s = await op('summary.month', { month: '2026-11' })
    expect(s.spendingCents).toBe(5000)
    expect(s.unconverted).toBe(1)
    const st = await op('fx.status', {})
    expect(st.currencies.map((c: any) => c.currency)).toEqual(['USD'])
    expect(st.currencies[0].latest).toBeNull()

    storeEcbRates(ctx.db, parseEcbCsv(ECB, new Set(['USD'])))
    s = await op('summary.month', { month: '2026-11' })
    expect(s.spendingCents).toBe(15000)
    expect(s.unconverted).toBe(0)
    expect(s.byCategory[0]).toMatchObject({ cents: 15000 })

    await op('fx.setRate', { currency: 'USD', date: '2026-11-12', perEur: 1.2 })
    s = await op('summary.month', { month: '2026-11' })
    expect(s.spendingCents).toBe(5000 + 9000)

    const accounts = await op('accounts.list', {})
    const us = accounts.find((a: any) => a.id === usd.id)
    expect(us.balanceCents).toBe(-10800)
    expect(typeof us.balanceMainCents).toBe('number')

    // Main currency USD: the euro amounts convert the other way.
    await op('settings.update', { currency: 'USD' })
    s = await op('summary.month', { month: '2026-11' })
    expect(s.spendingCents).toBe(6000 + 10800)

    // Correcting an account's currency relabels its transactions.
    await op('accounts.update', { id: usd.id, currency: 'GBP' })
    const list = await op('transactions.list', { accountId: usd.id })
    expect(list.items[0].currency).toBe('GBP')
  })
})
