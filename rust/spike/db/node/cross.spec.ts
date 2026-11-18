// Spike A, gates G4 and G5 (partly): cross-open between the app's own core (better-sqlite3-multiple-ciphers via
// openDatabase + migrations) and the Rust binary, and slot compatibility. All data is invented and lives in a
// temporary directory that is removed at the end.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { PASSWORD_KDF, makeSlot, openSlot, setPasswordKdfForTests, type Slot } from '@core/crypto'

const SPIKE = process.env.KB_SPIKE_BIN ?? resolve(import.meta.dirname, '../target/release/spike')
const KEY_HEX = 'a1'.repeat(8) + '00ff'.repeat(12)
const WRONG_HEX = '0'.repeat(63) + '1'
const dir = mkdtempSync(join(process.env.KB_SPIKE_TMP ?? tmpdir(), 'kb-spike-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rust = (...args: string[]): string => execFileSync(SPIKE, args, { encoding: 'utf8' })
const kv = (out: string): Record<string, string> =>
  Object.fromEntries(out.split('\n').flatMap((l) => l.split(/\s+/).filter((w) => w.includes('=')).map((w) => w.split('=') as [string, string])))

describe('database cross-open', () => {
  const nodeFile = join(dir, 'node-made.db')
  const rustFile = join(dir, 'rust-made.db')
  const counts: Record<string, number> = {}
  let sumCents = 0

  it('Node creates an encrypted DB with invented data', () => {
    const db = openDatabase(nodeFile, KEY_HEX)
    expect(db.pragma('user_version', { simple: true })).toBe(15)
    db.transaction(() => {
      const acc = db.prepare('INSERT INTO accounts (name, bank, iban, currency, opening_balance_cents) VALUES (?,?,?,?,?)')
      acc.run('Checking', 'other', 'BE68539007547034', 'EUR', 120_000)
      acc.run('Savings', 'other', 'BE71096123456769', 'EUR', 500_000)
      acc.run('Travel USD', 'other', null, 'USD', 0)
      const cat = db.prepare('INSERT INTO categories (name, kind, sort_order) VALUES (?,?,?)')
      // The first migration seeds default categories; these are extra, with unique names.
      const first = (db.prepare('SELECT max(id) AS m FROM categories').get() as { m: number }).m
      const names = ['Spike Groceries', 'Spike Rent', 'Spike Salary', 'Spike Transport', 'Spike Leisure', 'Spike Health', 'Spike Energy', 'Spike Gifts', 'Spike Transfer', 'Spike Café ☕', 'Spike Zażółć', 'Spike Other']
      names.forEach((n, i) => cat.run(n, n === 'Spike Salary' ? 'income' : n === 'Spike Transfer' ? 'transfer' : 'expense', i))
      const tx = db.prepare(
        `INSERT INTO transactions (account_id, booking_date, amount_cents, currency, description, counterparty_name, category_id, fingerprint)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      for (let i = 0; i < 2000; i++) {
        const month = String((i % 12) + 1).padStart(2, '0')
        const day = String((i % 28) + 1).padStart(2, '0')
        const amount = ((i * 7919) % 20000) - 9000
        tx.run((i % 3) + 1, `2025-${month}-${day}`, amount, i % 3 === 2 ? 'USD' : 'EUR', `Invented payment ${i}`, `Shop ${i % 37}`, first + (i % 12) + 1, `fp-${i}`)
      }
      const bud = db.prepare('INSERT INTO budgets (category_id, month, amount_cents) VALUES (?,?,?)')
      for (let c = 1; c <= 8; c++) for (let m = 1; m <= 12; m++) bud.run(first + c, `2025-${String(m).padStart(2, '0')}`, c * 10_000)
    })()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    for (const { name } of tables) counts[name] = (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n
    sumCents = (db.prepare('SELECT sum(amount_cents) AS s FROM transactions').get() as { s: number }).s
    db.close()
    expect(counts.transactions).toBe(2000)
  })

  it('Rust opens it: user_version 15, same row counts and sum', () => {
    const out = rust('open-db', nodeFile, KEY_HEX)
    console.log(out)
    const r = kv(out)
    expect(r.user_version).toBe('15')
    expect(r.foreign_keys).toBe('1')
    for (const [name, n] of Object.entries(counts)) expect(out.includes(`table ${name}=${n}\n`), `table ${name}`).toBe(true)
    expect(Number(r.tx_count)).toBe(2000)
    expect(Number(r.tx_sum_cents)).toBe(sumCents)
    expect(Number(r.rows_total)).toBe(Object.values(counts).reduce((a, b) => a + b, 0))
  })

  it('Rust rejects a wrong key; Node rejects it too', () => {
    expect(rust('wrong-key', nodeFile, WRONG_HEX)).toContain('rejected as expected')
    expect(() => openDatabase(nodeFile, WRONG_HEX)).toThrow(/db.locked|could not be unlocked/)
  })

  it('Rust creates a DB; Node (app core) opens and reads it', () => {
    expect(rust('write-db', rustFile, KEY_HEX)).toContain('written')
    const db = openDatabase(rustFile, KEY_HEX, { migrate: false })
    expect(db.prepare('SELECT id, note FROM rust_made ORDER BY id').all()).toEqual([
      { id: 1, note: 'hello from rust' },
      { id: 2, note: 'zażółć € ✓' }
    ])
    expect(db.pragma('user_version', { simple: true })).toBe(15)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    db.close()
    expect(() => openDatabase(rustFile, WRONG_HEX)).toThrow()
  })
})

describe('password slot compatibility', () => {
  const master = Buffer.from('11'.repeat(32), 'hex')
  // "ﬁ" (U+FB01) and "ë" in decomposed form normalise differently under NFKC; both sides must agree.
  const password = 'pässﬁ Zoë ①'
  const slotFile = join(dir, 'slot.json')

  for (const [label, params] of [['real default KDF', null], ['cheap test KDF', { m: 64, t: 1, p: 1 }]] as const) {
    it(`TS makes a slot (${label}), Rust unwraps it`, async () => {
      setPasswordKdfForTests(params)
      const slot = await makeSlot(master, password, 'password')
      setPasswordKdfForTests(null)
      if (!params) expect(slot.kdf).toMatchObject(PASSWORD_KDF)
      writeFileSync(slotFile, JSON.stringify(slot))
      expect(rust('unwrap', slotFile, password).trim()).toBe(master.toString('hex'))
      expect(() => rust('unwrap', slotFile, password + 'x')).toThrow()
    })

    it(`Rust wraps (${label}), TS unwraps it`, async () => {
      const p = params ?? PASSWORD_KDF
      const slot = JSON.parse(rust('wrap', master.toString('hex'), password, String(p.m), String(p.t), String(p.p))) as Slot
      expect(slot.kdf).toMatchObject({ name: 'argon2id', ...p })
      expect((await openSlot(slot, password, 'password'))?.toString('hex')).toBe(master.toString('hex'))
      expect(await openSlot(slot, password + 'x', 'password')).toBeNull()
    })
  }

  it('timing: TS (hash-wasm) vs Rust, real default KDF', async () => {
    setPasswordKdfForTests(null)
    const slot = await makeSlot(master, password, 'password')
    const ms: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      await openSlot(slot, password, 'password')
      ms.push(Math.round(performance.now() - t0))
    }
    console.log(`TS hash-wasm argon2id m=131072 t=3 p=4 runs_ms=[${ms.join(', ')}]`)
    console.log(rust('bench-kdf', '5').trim())
  })
})
