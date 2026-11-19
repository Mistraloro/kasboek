// Shared helpers of the parity specs: running the Rust dev binary (kb-cli), and building invented databases with the
// app's own code. Everything here is invented data in temporary directories.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Db } from '@core/database'
import { openDatabase } from '@core/database'
import { MIGRATIONS } from '@core/migrations'

export const SCHEMA_VERSION = MIGRATIONS.length
export const FIXTURES = resolve(import.meta.dirname, 'fixtures')

const exe = process.platform === 'win32' ? '.exe' : ''
const candidates = ['release', 'debug'].map((p) => resolve(import.meta.dirname, `../target/${p}/kb-cli${exe}`))
export const CLI = process.env.KB_CLI_BIN ?? candidates.find((c) => existsSync(c)) ?? candidates[0]!

export class CliError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

/** Runs kb-cli; returns its stdout. Throws CliError with the error code when it fails. */
export function cliText(args: string[], input?: string): string {
  try {
    return execFileSync(CLI, args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? ''
    try {
      const err = JSON.parse(out).error as { code: string; message: string }
      throw new CliError(err.code, err.message)
    } catch (inner) {
      if (inner instanceof CliError) throw inner
      throw e
    }
  }
}

export const cli = <T = any>(args: string[], input?: unknown): T => JSON.parse(cliText(args, input === undefined ? undefined : JSON.stringify(input))) as T

export function tempDir(prefix = 'kb-parity-'): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(process.env.KB_PARITY_TMP ?? tmpdir(), prefix))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Invented key: 32 bytes that protect nothing. */
export const KEY_HEX = '5a'.repeat(8) + '00ff'.repeat(12)
export const WRONG_HEX = '0'.repeat(63) + '1'

/** What the TypeScript core would have at schema `n`: open without migrating, apply the first n migrations. */
export function openAtSchema(file: string, keyHex: string, n: number): Db {
  const db = openDatabase(file, keyHex, { migrate: false })
  for (let v = 0; v < n; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}

/**
 * Invented rows for the tables that exist at schema `n`, using only columns of schema 1 (so it works at every
 * version). Covers what the migrations touch: placeholder bank references, whitespace and case in texts (fingerprints),
 * short and long rule patterns, rates from two sources on one day.
 */
export function seed(db: Db, n: number): void {
  db.transaction(() => {
    const acc = db.prepare('INSERT INTO accounts (name, bank, iban, currency, opening_balance_cents) VALUES (?,?,?,?,?)')
    acc.run('Checking', 'argenta', 'BE68539007547034', 'EUR', 120_000)
    acc.run('Savings', 'hellobank', 'BE71096123456769', 'EUR', 500_000)
    acc.run('Travel USD', 'keytrade', null, 'USD', 0)
    acc.run('Cash', 'other', null, 'EUR', 0)
    const cat = db.prepare('INSERT INTO categories (name, kind, sort_order) VALUES (?,?,?)')
    cat.run('Invented Café ☕', 'expense', 40)
    cat.run('Invented Zażółć', 'income', 41)
    const first = (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id
    const batch = db.prepare("INSERT INTO import_batches (account_id, file_name, status, row_count) VALUES (1, 'invented.csv', 'committed', 3)")
    batch.run()
    const tx = db.prepare(
      `INSERT INTO transactions (account_id, booking_date, amount_cents, currency, description, counterparty_name, counterparty_iban, category_id, bank_reference, fingerprint, import_batch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    const refs = ['2026-', '0000', '', '  ', '12345', 'REF-9', '2026/', '- / .', null, '2026-0001', '20267', '1999.']
    const texts = ['Shop  ONE', '  Invented\tpayment ', 'ΑΣ ΣΑΣ', 'İstanbul ß Straße', 'plain', 'zażółć € ✓', 'MiXeD   Case']
    for (let i = 0; i < 48; i++) {
      const day = String((i % 28) + 1).padStart(2, '0')
      const month = String((i % 12) + 1).padStart(2, '0')
      tx.run(
        (i % 4) + 1,
        `2025-${month}-${day}`,
        ((i * 7919) % 20000) - 9000,
        i % 4 === 2 ? 'USD' : 'EUR',
        texts[i % texts.length],
        i % 5 === 0 ? null : texts[(i + 3) % texts.length],
        i % 3 === 0 ? 'BE62510007547061' : null,
        first + (i % 5),
        refs[i % refs.length],
        `fp-${i}`,
        i % 2 ? 1 : null
      )
    }
    const bud = db.prepare('INSERT INTO budgets (category_id, month, amount_cents) VALUES (?,?,?)')
    for (let c = 0; c < 4; c++) for (let m = 1; m <= 3; m++) bud.run(first + c, `2025-0${m}`, (c + 1) * 10_000)
    db.prepare('INSERT INTO csv_profiles (name, bank, header_signature, mapping_json) VALUES (?,?,?,?)').run('Invented bank', 'other', 'date;amount;text', '{"columns":{}}')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('currency', 'EUR')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark')
    db.prepare("INSERT INTO audit_log (actor, action, details) VALUES ('user', 'invented.seed', '{}')").run()
    if (n >= 2) {
      const rule = db.prepare('INSERT INTO rules (field, pattern, category_id) VALUES (?,?,?)')
      rule.run('counterparty', 'ab', first)
      rule.run('description', 'abc', first + 1)
      rule.run('any', 'a long invented pattern', first + 2)
      rule.run('counterparty', '  x ', first + 3)
      db.prepare("INSERT INTO secrets (key, value) VALUES ('invented.api', 'not-a-real-key')").run()
    }
    if (n >= 4) {
      const fx = db.prepare('INSERT INTO fx_rates (currency, date, per_eur, source) VALUES (?,?,?,?)')
      fx.run('USD', '2025-01-01', 1.1, 'ecb')
      fx.run('USD', '2025-03-01', 1.2, 'ecb')
      fx.run('USD', '2025-03-01', 1.25, 'manual')
      fx.run('JPY', '2025-02-01', 160, 'ecb')
    }
    if (n >= 5) {
      db.prepare("INSERT INTO valuations (account_id, date, value_cents, note) VALUES (2, '2025-02-01', 510000, 'invented')").run()
    }
  })()
}
