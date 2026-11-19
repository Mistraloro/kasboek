// Database cross-open and migration parity between the app's own core (better-sqlite3-multiple-ciphers, src/core)
// and the Rust store (kb-db through kb-cli). All data is invented and lives in a temporary directory.
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { integrityOk, openDatabase, snapshotEncrypted } from '@core/database'
import { migrate } from '@core/migrations'
import { CliError, KEY_HEX, SCHEMA_VERSION, WRONG_HEX, cli, cliText, openAtSchema, seed, tempDir } from './helpers'

const tmp = tempDir()
afterAll(() => tmp.remove())
const file = (name: string): string => join(tmp.dir, name)

function tsCounts(db: ReturnType<typeof openDatabase>): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]))
}

describe('cross-open', () => {
  for (const n of [1, SCHEMA_VERSION]) {
    it(`TS creates a schema ${n} database, Rust reads it (same schema version and row counts)`, () => {
      const f = file(`ts-${n}.db`)
      const db = openAtSchema(f, KEY_HEX, n)
      seed(db, n)
      const counts = tsCounts(db)
      db.close()
      const r = cli(['db-open', f, KEY_HEX, '--no-migrate'])
      expect(r.schemaVersion).toBe(n)
      expect(r.tables).toEqual(counts)
      expect(r.integrityOk).toBe(true)
      const dump = cliText(['db-dump', f, KEY_HEX])
      expect(dump).toContain('user_version=' + n)
      expect(dump).toContain('Invented Café ☕')
      expect(dump).toContain('zażółć € ✓')
    })

    it(`Rust creates a schema ${n} database, TS reads it`, () => {
      const f = file(`rust-${n}.db`)
      cli(['db-create', f, KEY_HEX, String(n)])
      const db = openAtSchema(f, KEY_HEX, 0)
      expect(db.pragma('user_version', { simple: true })).toBe(n)
      expect(integrityOk(db)).toBe(true)
      seed(db, n)
      const counts = tsCounts(db)
      db.close()
      expect(cli(['db-open', f, KEY_HEX, '--no-migrate']).tables).toEqual(counts)
    })
  }

  it('a wrong key is refused on both sides', () => {
    const f = file('ts-1.db')
    expect(() => cli(['db-open', f, WRONG_HEX])).toThrowError(CliError)
    try {
      cli(['db-open', f, WRONG_HEX])
    } catch (e) {
      expect((e as CliError).code).toBe('db.locked')
    }
    expect(() => openDatabase(f, WRONG_HEX)).toThrow(/unlocked/)
    const g = file('rust-1.db')
    expect(() => openDatabase(g, WRONG_HEX)).toThrow(/unlocked/)
    expect(() => cli(['db-open', g, WRONG_HEX])).toThrow(/db.locked/)
  })

  it('a key that is not 64 lower-case hex characters is refused on both sides', () => {
    expect(() => cli(['db-open', file('ts-1.db'), 'AB'.repeat(32)])).toThrow(/db.bad_key/)
    expect(() => openDatabase(file('ts-1.db'), 'AB'.repeat(32))).toThrow(/32 bytes of hex/)
  })

  it('a database from a newer version is refused by Rust like by TS', () => {
    const f = file('newer.db')
    const db = openAtSchema(f, KEY_HEX, SCHEMA_VERSION)
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => cli(['db-migrate', f, KEY_HEX])).toThrow(/db.newer_schema/)
    expect(() => openDatabase(f, KEY_HEX)).toThrow(/newer version/)
  })

  it('VACUUM INTO: each side opens the other side\'s encrypted snapshot, with the same key only', () => {
    const live = file('ts-15.db')
    const tsSnap = file('snap-ts.db')
    const rustSnap = file('snap-rust.db')
    const db = openDatabase(live, KEY_HEX)
    snapshotEncrypted(db, tsSnap)
    const counts = tsCounts(db)
    db.close()
    expect(cli(['db-open', tsSnap, KEY_HEX]).tables).toEqual(counts)
    expect(() => cli(['db-open', tsSnap, WRONG_HEX])).toThrow(/db.locked/)
    cli(['db-snapshot', live, KEY_HEX, rustSnap])
    const copy = openDatabase(rustSnap, KEY_HEX)
    expect(tsCounts(copy)).toEqual(counts)
    expect(integrityOk(copy)).toBe(true)
    copy.close()
    expect(() => openDatabase(rustSnap, WRONG_HEX)).toThrow(/unlocked/)
  })
})

describe('migration paths 1 to 15: the dump of Rust\'s migration equals the dump of TS\'s migration', () => {
  for (const maker of ['ts', 'rust'] as const) {
    for (let n = 1; n <= SCHEMA_VERSION; n++) {
      it(`${maker}-made schema ${n}`, () => {
        const origin = file(`mig-${maker}-${n}.db`)
        if (maker === 'rust') cli(['db-create', origin, KEY_HEX, String(n)])
        const db = openAtSchema(origin, KEY_HEX, maker === 'ts' ? n : 0)
        seed(db, n)
        db.close()
        const byTs = file(`mig-${maker}-${n}.ts.db`)
        const byRust = file(`mig-${maker}-${n}.rust.db`)
        copyFileSync(origin, byTs)
        copyFileSync(origin, byRust)

        const ts = openDatabase(byTs, KEY_HEX, { migrate: false })
        migrate(ts)
        ts.close()
        expect(cli(['db-migrate', byRust, KEY_HEX]).schemaVersion).toBe(SCHEMA_VERSION)

        const tsDump = cliText(['db-dump', byTs, KEY_HEX])
        const rustDump = cliText(['db-dump', byRust, KEY_HEX])
        expect(tsDump.startsWith(`user_version=${SCHEMA_VERSION}\n`)).toBe(true)
        // Compared as lines so a failure shows the first differing statement or row.
        expect(rustDump.split('\n')).toEqual(tsDump.split('\n'))
      })
    }
  }

  it('the dump sees what the migrations changed: references, fingerprints, rules, triggers', () => {
    const dump = cliText(['db-dump', file('mig-ts-1.rust.db'), KEY_HEX])
    expect(dump).toContain('CREATE TRIGGER sync_rules_ins')
    expect(dump).toContain('CREATE VIEW tx_lines')
    expect(dump).toContain("'iban'")
    // Placeholder references ('2026-', '0000', ...) lose their reference and get a new fingerprint; real ones keep both.
    expect(dump).not.toContain('t:"fp-0"')
    expect(dump).toContain('t:"fp-4"')
    expect(dump).toContain('t:"REF-9"')
  })
})
