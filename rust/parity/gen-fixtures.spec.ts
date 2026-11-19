// Writes the known-answer fixtures in rust/parity/fixtures from the app's own TypeScript code. Skipped unless
// KB_WRITE_FIXTURES=1 (the files are committed; regenerate only when a format changes on purpose):
//   KB_WRITE_FIXTURES=1 npx vitest run --config rust/parity/vitest.config.ts gen-fixtures
// Everything is invented: the keys, passwords and rows protect nothing real.
import { argon2id } from 'hash-wasm'
import { createHash, hkdfSync, scryptSync } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAccount, sealVault, setTwoFactor, type Vault } from '@core/account'
import { migrate } from '@core/migrations'
import { openDatabase } from '@core/database'
import { PASSWORD_KDF, makeSlot, seal, setPasswordKdfForTests } from '@core/crypto'
import { sealSyncFile } from '@core/sync-file'
import { encodeTransfer } from '@core/transfer-format'
import { FIXTURES, KEY_HEX, SCHEMA_VERSION, openAtSchema, seed } from './helpers'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe.runIf(process.env.KB_WRITE_FIXTURES === '1')('write fixtures', () => {
  it('writes kat.json and the files next to it', async () => {
    mkdirSync(FIXTURES, { recursive: true })
    const at = (name: string): string => join(FIXTURES, name)
    const tables = (f: string, n: number) => {
      const db = openDatabase(f, KEY_HEX, { migrate: false })
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
      const counts = Object.fromEntries(names.map(({ name }) => [name, (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]))
      expect(db.pragma('user_version', { simple: true })).toBe(n)
      db.close()
      return counts
    }

    // Databases: schema 1, schema 15, and the schema 1 file as migrated by the TypeScript core.
    for (const n of [1, SCHEMA_VERSION]) {
      rmSync(at(`schema${n}.db`), { force: true })
      const db = openAtSchema(at(`schema${n}.db`), KEY_HEX, n)
      seed(db, n)
      db.close()
    }
    copyFileSync(at('schema1.db'), at('schema1-migrated-by-ts.db'))
    const migrated = openDatabase(at('schema1-migrated-by-ts.db'), KEY_HEX, { migrate: false })
    migrate(migrated)
    migrated.close()

    // Credentials and keys.
    const password = 'invented fixture password ✓'
    const master = Buffer.from('0f'.repeat(32), 'hex')
    const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const recoveryKey = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723'
    const recoveryNormalized = recoveryKey

    // Slots.
    const defaultSlot = await makeSlot(master, password, 'password')
    setPasswordKdfForTests({ m: 64, t: 1, p: 1 })
    const cheapSlot = await makeSlot(master, password, 'password')
    setPasswordKdfForTests(null)
    const recoverySlot = await makeSlot(master, recoveryNormalized, 'recovery')
    const scryptSalt = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex')
    const scryptSlot = {
      kdf: { name: 'scrypt' as const, N: 16384, r: 8, p: 1, salt: scryptSalt.toString('base64') },
      sealed: seal(scryptSync(password.normalize('NFKC'), scryptSalt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }), master, 'kasboek:slot:password')
    }

    // Derived keys, computed independently of the app's slot code (hash-wasm, node:crypto).
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
    const kdfVectors = {
      argon2id: Object.fromEntries(
        await Promise.all(
          [
            ['default', PASSWORD_KDF],
            ['cheap', { m: 64, t: 1, p: 1 }]
          ].map(async ([name, c]) => [name as string, { ...(c as typeof PASSWORD_KDF), keyHex: Buffer.from(await argon2id({ password: password.normalize('NFKC'), salt, parallelism: (c as typeof PASSWORD_KDF).p, iterations: (c as typeof PASSWORD_KDF).t, memorySize: (c as typeof PASSWORD_KDF).m, hashLength: 32, outputType: 'binary' })).toString('hex') }])
        )
      ),
      scrypt: { N: 16384, r: 8, p: 1, keyHex: scryptSync(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex') },
      hkdf: { info: 'kasboek:slot', keyHex: Buffer.from(hkdfSync('sha256', Buffer.from(recoveryNormalized), salt, Buffer.from('kasboek:slot'), 32)).toString('hex') },
      saltHex: salt.toString('hex'),
      password
    }

    // Vault.
    const vault: Vault = { dbKey: KEY_HEX, totp: { secret: totpSecret, lastStep: -1 } }
    const sealedVault = sealVault(master, vault)

    // .kasboek exports: payload is the schema 1 database file (still encrypted).
    setPasswordKdfForTests({ m: 64, t: 1, p: 1 })
    const created = await createAccount({ mode: 'password', password, dbKey: KEY_HEX })
    setPasswordKdfForTests(null)
    const dbFile = readFileSync(at('schema1.db'))
    // Re-wrap the fixture master key so every fixture uses the same credentials.
    const account = { ...created.account, slots: { password: cheapSlot, recovery: recoverySlot } }
    writeFileSync(at('export.kasboek'), encodeTransfer({ kind: 'export', account, master, vault: { dbKey: KEY_HEX }, dbFile, appVersion: '0.0.0-fixture', schemaVersion: 1 }))
    const twoFactor = setTwoFactor(account, master, { dbKey: KEY_HEX }, { secret: totpSecret, lastStep: -1 })
    writeFileSync(at('export-2fa.kasboek'), encodeTransfer({ kind: 'backup', account: twoFactor.account, master, vault: twoFactor.vault, dbFile, appVersion: '0.0.0-fixture', schemaVersion: 1 }))

    // .kbsync.
    const syncKey = Buffer.from('3c'.repeat(32), 'hex')
    const syncHeader = { v: 1, account: 'fixture-account', device: 'fixture-device', seq: 3 }
    const syncPayload = {
      changes: [
        { tbl: 'accounts', uid: 'fixture-uid-1', data: { name: 'Invented current account ✓', currency: 'EUR', opening_balance_cents: 120000 } },
        { tbl: 'transactions', uid: 'fixture-uid-2', data: { description: 'Zażółć gęślą jaźń', amount_cents: -1250, ratio: 0.125, note: null } }
      ]
    }
    writeFileSync(at('changes.kbsync'), sealSyncFile(syncKey, syncHeader, syncPayload))

    const rfc = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130']
    ]
    writeFileSync(
      at('kat.json'),
      JSON.stringify(
        {
          note: 'Invented known-answer fixtures made by the TypeScript core. The keys and passwords protect nothing real. Regenerate with gen-fixtures.spec.ts.',
          dbKeyHex: KEY_HEX,
          masterHex: master.toString('hex'),
          password,
          recoveryKey,
          kdfVectors,
          slots: { passwordDefault: defaultSlot, passwordCheap: cheapSlot, recovery: recoverySlot, scrypt: scryptSlot },
          vault: { plain: vault, sealed: sealedVault },
          totp: { secret: totpSecret, rfc6238Sha1Digits8: rfc },
          transfer: { file: 'export.kasboek', file2fa: 'export-2fa.kasboek', dbSha256: sha(dbFile), appVersion: '0.0.0-fixture', schemaVersion: 1, totpNow: 1234567890, totpCode: '005924' },
          sync: { file: 'changes.kbsync', keyHex: syncKey.toString('hex'), header: syncHeader, payload: syncPayload },
          db: {
            schema1: { file: 'schema1.db', userVersion: 1, tables: tables(at('schema1.db'), 1) },
            schema15: { file: 'schema15.db', userVersion: SCHEMA_VERSION, tables: tables(at('schema15.db'), SCHEMA_VERSION) },
            schema1MigratedByTs: { file: 'schema1-migrated-by-ts.db', userVersion: SCHEMA_VERSION, tables: tables(at('schema1-migrated-by-ts.db'), SCHEMA_VERSION) }
          }
        },
        null,
        2
      ) + '\n'
    )
  })
})
