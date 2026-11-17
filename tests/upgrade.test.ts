import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { MIGRATIONS, migrate, schemaVersion } from '@core/migrations'
import { listRules } from '@core/finance'

describe('upgrading a 0.10.0 database (build 14, schema 7)', () => {
  it('keeps rules, sync ids and data, and records changes to the rebuilt and new tables', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kb-up-')), 'k.db')
    const key = randomBytes(32).toString('hex')
    const old = openDatabase(file, key, { migrate: false })
    old.transaction(() => {
      MIGRATIONS.slice(0, 7).forEach((m) => m(old))
      old.pragma('user_version = 7')
    })()
    const groceries = (old.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id
    const acc = Number(old.prepare("INSERT INTO accounts (name) VALUES ('Zicht')").run().lastInsertRowid)
    old.prepare("INSERT INTO rules (field, pattern, match, priority, category_id) VALUES ('counterparty', 'Delhaize', 'contains', 3, ?)").run(groceries)
    old.prepare("INSERT INTO rules (field, pattern, category_id) VALUES ('any', 'FOD', ?)").run(groceries)
    old.prepare(
      "INSERT INTO transactions (account_id, booking_date, amount_cents, currency, description, counterparty_name, bank_reference, fingerprint) VALUES (?, '2026-11-14', -7115, 'EUR', 'Betaling', 'Shop', '2026-', 'x')"
    ).run(acc)
    const ruleUids = (old.prepare('SELECT uid FROM rules ORDER BY id').all() as { uid: string }[]).map((r) => r.uid)
    expect(ruleUids.every(Boolean)).toBe(true)
    // Sync switched on in 0.10.0 (by its own code): only the flag matters here.
    old.prepare('UPDATE sync_flags SET enabled = 1').run()
    old.close()

    const db = openDatabase(file, key)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    const rules = listRules(db)
    expect(rules.map((r) => [r.pattern, r.match, r.priority])).toEqual([
      ['Delhaize', 'contains', 3],
      ['FOD', 'word', 0]
    ])
    expect((db.prepare('SELECT uid FROM rules ORDER BY id').all() as { uid: string }[]).map((r) => r.uid)).toEqual(ruleUids)
    const t = db.prepare('SELECT bank_reference, bank_counterparty, bank_description, transfer_pair FROM transactions').get()
    expect(t).toEqual({ bank_reference: null, bank_counterparty: 'Shop', bank_description: 'Betaling', transfer_pair: null })
    // Changes after the upgrade are still recorded for sync: rules (rebuilt), splits and goals (new).
    db.prepare('DELETE FROM sync_outbox').run()
    db.prepare("INSERT INTO rules (field, pattern, category_id) VALUES ('iban', 'BE68539007547034', ?)").run(groceries)
    db.prepare("INSERT INTO goals (name, target_cents) VALUES ('Holiday', 100000)").run()
    const txId = (db.prepare('SELECT id FROM transactions').get() as { id: number }).id
    db.prepare('INSERT INTO transaction_splits (tx_id, category_id, amount_cents) VALUES (?, ?, -7115)').run(txId, groceries)
    // (Inserting also sets the uid, so a row can be listed twice; sending reads each once.)
    const outbox = [...new Set((db.prepare('SELECT tbl FROM sync_outbox ORDER BY id').all() as { tbl: string }[]).map((r) => r.tbl))]
    expect(outbox).toEqual(['rules', 'goals', 'transaction_splits'])
    expect((db.prepare('SELECT count(*) AS n FROM goals WHERE uid IS NOT NULL').get() as { n: number }).n).toBe(1)
    // Migrating again does nothing.
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  })

describe('upgrading from the schema before fixed-cost marks', () => {
  it('keeps the data, adds the table and records its changes for sync', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kb-up-')), 'k.db')
    const key = randomBytes(32).toString('hex')
    const previous = MIGRATIONS.length - 1
    const old = openDatabase(file, key, { migrate: false })
    old.transaction(() => {
      MIGRATIONS.slice(0, previous).forEach((m) => m(old))
      old.pragma(`user_version = ${previous}`)
    })()
    old.prepare("INSERT INTO accounts (name) VALUES ('Zicht')").run()
    old.prepare('UPDATE sync_flags SET enabled = 1').run()
    expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'recurring_marks'").get()).toBeUndefined()
    old.close()

    const db = openDatabase(file, key)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT name FROM accounts').all()).toEqual([{ name: 'Zicht' }])
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'recurring_marks' ORDER BY name").all()
    expect(triggers).toEqual([{ name: 'sync_recurring_marks_del' }, { name: 'sync_recurring_marks_ins' }, { name: 'sync_recurring_marks_upd' }])
    db.prepare('DELETE FROM sync_outbox').run()
    db.prepare("INSERT INTO recurring_marks (key, hidden) VALUES ('out:streamly', 1)").run()
    expect(db.prepare('SELECT DISTINCT tbl, uid FROM sync_outbox').all()).toEqual([{ tbl: 'recurring_marks', uid: 'out:streamly' }])
  })
})
})
