import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeBackup, encodeBackup, readBackupHeader, backupFileName } from '@core/backup-format'
import { integrityOk, openDatabase, snapshotEncrypted } from '@core/database'
import { schemaVersion } from '@core/migrations'

// Low KDF cost keeps the tests fast; the app uses DEFAULT_KDF.
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'kasboek-test-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('encrypted database', () => {
  it('is not readable as plain SQLite and needs the right key', () => {
    const dir = tmp()
    const key = randomBytes(32).toString('hex')
    const db = openDatabase(join(dir, 'k.db'), key)
    db.prepare("INSERT INTO accounts (name, bank) VALUES ('Secret account', 'argenta')").run()
    db.close()

    const raw = readFileSync(join(dir, 'k.db'))
    expect(raw.subarray(0, 15).toString()).not.toBe('SQLite format 3')
    expect(raw.includes(Buffer.from('Secret account'))).toBe(false)

    expect(() => openDatabase(join(dir, 'k.db'), randomBytes(32).toString('hex'))).toThrow(/could not be unlocked/)
    const again = openDatabase(join(dir, 'k.db'), key)
    expect(again.prepare('SELECT name FROM accounts').get()).toEqual({ name: 'Secret account' })
    again.close()
  })

  it('creates the schema and default categories', () => {
    const db = openDatabase(join(tmp(), 'k.db'), randomBytes(32).toString('hex'))
    expect(schemaVersion(db)).toBe(1)
    const n = db.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }
    expect(n.n).toBeGreaterThan(10)
    db.close()
  })
})

describe('backup file', () => {
  it('round-trips the encrypted database with only the password', async () => {
    const dir = tmp()
    const key = randomBytes(32).toString('hex')
    const db = openDatabase(join(dir, 'live.db'), key)
    db.prepare("INSERT INTO accounts (name, bank, iban) VALUES ('Keytrade', 'keytrade', 'BE00')").run()
    snapshotEncrypted(db, join(dir, 'snap.db'))
    const snap = readFileSync(join(dir, 'snap.db'))
    expect(snap.includes(Buffer.from('Keytrade'))).toBe(false)

    const file = await encodeBackup({ password: 'correct horse battery', dbKeyHex: key, dbFile: snap, appVersion: '0.1.0', schemaVersion: 1, kdf: FAST })
    expect(file.includes(Buffer.from('Keytrade'))).toBe(false)
    expect(readBackupHeader(file).appVersion).toBe('0.1.0')

    const out = await decodeBackup(file, 'correct horse battery')
    expect(out.dbKeyHex).toBe(key)
    writeFileSync(join(dir, 'restored.db'), out.dbFile)
    const restored = openDatabase(join(dir, 'restored.db'), out.dbKeyHex)
    expect(integrityOk(restored)).toBe(true)
    expect(restored.prepare('SELECT name, iban FROM accounts').all()).toEqual([{ name: 'Keytrade', iban: 'BE00' }])
    restored.close()
    db.close()
  })

  it('rejects a wrong password', async () => {
    const file = await encodeBackup({ password: 'right password!', dbKeyHex: 'ab'.repeat(32), dbFile: Buffer.from('x'.repeat(100)), appVersion: '0.1.0', schemaVersion: 1, kdf: FAST })
    await expect(decodeBackup(file, 'wrong password!')).rejects.toMatchObject({ code: 'backup.wrong_password' })
  })

  it('detects tampering with the body or the header', async () => {
    const file = await encodeBackup({ password: 'right password!', dbKeyHex: 'ab'.repeat(32), dbFile: Buffer.from('x'.repeat(100)), appVersion: '0.1.0', schemaVersion: 1, kdf: FAST })
    const body = Buffer.from(file)
    body[body.length - 40]! ^= 1
    await expect(decodeBackup(body, 'right password!')).rejects.toMatchObject({ code: 'backup.wrong_password' })

    const header = Buffer.from(file.toString('latin1').replace('"appVersion":"0.1.0"', '"appVersion":"9.9.9"'), 'latin1')
    await expect(decodeBackup(header, 'right password!')).rejects.toMatchObject({ code: 'backup.wrong_password' })
  })

  it('refuses files that are not backups', async () => {
    await expect(decodeBackup(Buffer.from('hello world, not a backup'), 'x')).rejects.toMatchObject({ code: 'backup.not_a_backup' })
  })

  it('names files so they sort by date', () => {
    expect(backupFileName(new Date(2026, 10, 12, 9, 5, 7))).toBe('kasboek-2026-11-12_090507.kasboek')
  })
})
