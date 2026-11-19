// The committed known-answer fixtures (rust/parity/fixtures) still read with the app's own TypeScript code. Together
// with rust/crates/*/tests/kat.rs (the same fixtures read by Rust) this pins both sides to the same bytes.
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openVault } from '@core/account'
import { openDatabase } from '@core/database'
import { openSlot } from '@core/crypto'
import { migrate } from '@core/migrations'
import { openSyncFile } from '@core/sync-file'
import { openTransfer } from '@core/transfer-format'
import { cliText, tempDir, FIXTURES } from './helpers'

const kat = JSON.parse(readFileSync(join(FIXTURES, 'kat.json'), 'utf8'))
const tmp = tempDir()
afterAll(() => tmp.remove())
const bytes = (name: string): Buffer => readFileSync(join(FIXTURES, name))
const master = Buffer.from(kat.masterHex, 'hex')

describe('fixtures read by the TypeScript core', () => {
  it('slots', async () => {
    for (const [name, kind] of [['passwordDefault', 'password'], ['passwordCheap', 'password'], ['scrypt', 'password']] as const) {
      expect((await openSlot(kat.slots[name], kat.password, kind))?.equals(master), name).toBe(true)
    }
    expect((await openSlot(kat.slots.recovery, kat.recoveryKey, 'recovery'))?.equals(master)).toBe(true)
  })

  it('vault', () => {
    expect(openVault(master, kat.vault.sealed)).toEqual(kat.vault.plain)
  })

  it('exports', async () => {
    const plain = await openTransfer(bytes(kat.transfer.file), { password: kat.password })
    expect(createHash('sha256').update(plain.dbFile).digest('hex')).toBe(kat.transfer.dbSha256)
    expect((await openTransfer(bytes(kat.transfer.file2fa), { recoveryKey: kat.recoveryKey })).master.equals(master)).toBe(true)
  })

  it('sync file', () => {
    expect(openSyncFile(Buffer.from(kat.sync.keyHex, 'hex'), bytes(kat.sync.file), kat.sync.header)).toEqual(kat.sync.payload)
  })

  it('databases: versions and counts; the TS-migrated schema 1 file equals a fresh migration of schema1.db', () => {
    for (const d of Object.values(kat.db) as { file: string; userVersion: number; tables: Record<string, number> }[]) {
      const db = openDatabase(join(FIXTURES, d.file), kat.dbKeyHex, { migrate: false })
      expect(db.pragma('user_version', { simple: true }), d.file).toBe(d.userVersion)
      for (const [t, n] of Object.entries(d.tables)) expect((db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n, `${d.file} ${t}`).toBe(n)
      db.close()
    }
    const copy = join(tmp.dir, 'copy.db')
    copyFileSync(join(FIXTURES, 'schema1.db'), copy)
    const db = openDatabase(copy, kat.dbKeyHex, { migrate: false })
    migrate(db)
    db.close()
    const other = join(FIXTURES, 'schema1-migrated-by-ts.db')
    expect(cliText(['db-dump', copy, kat.dbKeyHex]).split('\n')).toEqual(cliText(['db-dump', other, kat.dbKeyHex]).split('\n'))
  })
})
