// File codec parity: .kasboek export/backup (KASBOEK2, src/core/transfer-format.ts) and .kbsync (KBSYNC1,
// src/core/sync-file.ts), between the TypeScript core and kb-crypto (through kb-cli). Invented data only.
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount, setPasswordless, setTwoFactor, type AccountData, type Vault } from '@core/account'
import { openDatabase } from '@core/database'
import { setPasswordKdfForTests, type Slot } from '@core/crypto'
import { openSyncFile, sealSyncFile } from '@core/sync-file'
import { encodeTransfer, openTransfer, readTransferHeader, type TransferHeader } from '@core/transfer-format'
import { totpAt } from '@core/totp'
import { CliError, KEY_HEX, SCHEMA_VERSION, cli, openAtSchema, seed, tempDir } from './helpers'

const tmp = tempDir()
afterAll(() => tmp.remove())
const file = (name: string): string => join(tmp.dir, name)
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const PASSWORD = 'invented password ✓'
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
let account: AccountData
let master: Buffer
let vault: Vault
let recoveryKey: string
let dbFile: Buffer

beforeAll(async () => {
  setPasswordKdfForTests({ m: 64, t: 1, p: 1 })
  const created = await createAccount({ mode: 'password', password: PASSWORD, dbKey: KEY_HEX })
  setPasswordKdfForTests(null)
  ;({ account, master, vault, recoveryKey } = created)
  // A real, still-encrypted database as the payload.
  const db = openAtSchema(file('payload.db'), KEY_HEX, SCHEMA_VERSION)
  seed(db, SCHEMA_VERSION)
  db.close()
  dbFile = readFileSync(file('payload.db'))
})

const encode = (acc: AccountData, v: Vault, kind: 'export' | 'backup' = 'export'): Buffer =>
  encodeTransfer({ kind, account: acc, master, vault: v, dbFile, appVersion: '0.0.0-parity', schemaVersion: SCHEMA_VERSION })

const rustOpen = (f: Buffer, cred: string[], now = Date.now() / 1000) => {
  writeFileSync(file('in.kasboek'), f)
  return cli(['transfer-open', file('in.kasboek'), file('out.db'), String(now), ...cred])
}
const rustCode = (f: Buffer, cred: string[]): string => {
  try {
    rustOpen(f, cred)
  } catch (e) {
    if (e instanceof CliError) return e.code
    throw e
  }
  return 'ok'
}
type Cred = { password: string; code?: string } | { recoveryKey: string }
const tsCode = async (f: Buffer, cred: Cred): Promise<string> => {
  try {
    await openTransfer(f, cred)
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
  return 'ok'
}
const toCli = (cred: Cred): string[] => ('recoveryKey' in cred ? ['recovery', cred.recoveryKey] : cred.code ? ['password', cred.password, cred.code] : ['password', cred.password])

describe('.kasboek written by TS, read by Rust', () => {
  it('opens with the password: same header, master key, vault and database bytes', async () => {
    const f = encode(account, vault, 'backup')
    const r = rustOpen(f, ['password', PASSWORD])
    const ts = await openTransfer(f, { password: PASSWORD })
    expect(r.header).toEqual(ts.header)
    expect(r.master).toBe(ts.master.toString('hex'))
    expect(r.vault).toEqual(ts.vault)
    expect(r.usedRecovery).toBe(false)
    expect(r.dbSha256).toBe(sha(dbFile))
    expect(sha(readFileSync(file('out.db')))).toBe(sha(dbFile))
    // The database that came out opens with the app's own code.
    const db = openDatabase(file('out.db'), r.vault.dbKey)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('opens with the recovery key, typed in lower case with spaces', () => {
    const f = encode(account, vault)
    const r = rustOpen(f, ['recovery', recoveryKey.toLowerCase().replaceAll('-', ' ')])
    expect(r.usedRecovery).toBe(true)
    expect(r.master).toBe(master.toString('hex'))
    expect(r.dbSha256).toBe(sha(dbFile))
  })

  it('a passwordless export needs the recovery key', async () => {
    const f = encode(setPasswordless(account, master), vault)
    expect(readTransferHeader(f).slots.password).toBeUndefined()
    expect(rustCode(f, ['password', PASSWORD])).toBe('transfer.needs_recovery')
    expect(await tsCode(f, { password: PASSWORD })).toBe('transfer.needs_recovery')
    expect(rustCode(f, ['recovery', recoveryKey])).toBe('ok')
  })

  it('2FA: the code decides, the recovery key skips it, the used step is recorded like TS records it', async () => {
    const totp = { secret: TOTP_SECRET, lastStep: -1 }
    const { account: acc2, vault: vault2 } = setTwoFactor(account, master, { ...vault }, totp)
    const f = encode(acc2, vault2)
    const now = Math.floor(Date.now() / 1000)
    const good = totpAt(TOTP_SECRET, now)
    expect(rustCode(f, ['password', PASSWORD])).toBe('transfer.wrong_credentials')
    const wrong = good === '000000' ? '000001' : '000000'
    expect(rustCode(f, ['password', PASSWORD, wrong])).toBe('transfer.wrong_credentials')
    const r = rustOpen(f, ['password', PASSWORD, good], now)
    const ts = await openTransfer(f, { password: PASSWORD, code: good })
    expect(r.vault).toEqual(ts.vault)
    expect(r.vault.totp.lastStep).toBe(Math.floor(now / 30))
    expect(rustCode(f, ['recovery', recoveryKey])).toBe('ok')
  })

  it('refusals carry the same codes as TS', async () => {
    const good = encode(account, vault)
    const cases: [string, Buffer, Cred][] = []
    cases.push(['wrong password', good, { password: 'nope' }])
    cases.push(['wrong recovery key', good, { recoveryKey: 'AAAA-BBBB' }])
    const flip = (b: Buffer, at: number): Buffer => {
      const c = Buffer.from(b)
      c[at < 0 ? c.length + at : at]! ^= 1
      return c
    }
    cases.push(['changed tag', flip(good, -1), { password: PASSWORD }])
    cases.push(['changed payload', flip(good, good.length - 40), { password: PASSWORD }])
    cases.push(['KASBOEK1', Buffer.concat([Buffer.from('KASBOEK1'), randomBytes(64)]), { password: PASSWORD }])
    cases.push(['not a kasboek file', randomBytes(200), { password: PASSWORD }])
    cases.push(['too short', Buffer.from('KASBOEK2'), { password: PASSWORD }])
    const withHeader = (header: Buffer | string, tail = 32): Buffer => {
      const h = Buffer.from(header)
      const len = Buffer.alloc(4)
      len.writeUInt32BE(h.length)
      return Buffer.concat([Buffer.from('KASBOEK2'), len, h, randomBytes(tail)])
    }
    cases.push(['header length 0', Buffer.concat([Buffer.from('KASBOEK2'), Buffer.alloc(4), randomBytes(40)]), { password: PASSWORD }])
    cases.push(['header over 64 KiB', withHeader(Buffer.alloc(64 * 1024 + 1, 0x20)), { password: PASSWORD }])
    cases.push(['header exactly 64 KiB but not JSON', withHeader(Buffer.alloc(64 * 1024, 0x20)), { password: PASSWORD }])
    cases.push(['header longer than the file', Buffer.concat([Buffer.from('KASBOEK2'), Buffer.from([0, 0, 1, 0]), Buffer.from('{}')]), { password: PASSWORD }])
    cases.push(['newer format', withHeader('{"format":3}'), { password: PASSWORD }])
    cases.push(['header not JSON', withHeader('not json'), { password: PASSWORD }])
    // A header edited inside a valid file: the associated data no longer matches.
    const text = good.toString('latin1')
    const edited = Buffer.from(text.replace('"appVersion":"0.0.0-parity"', '"appVersion":"0.0.0-parit!"'), 'latin1')
    cases.push(['header edited', edited, { password: PASSWORD }])

    for (const [label, f, cred] of cases) {
      const ts = await tsCode(f, cred)
      expect(ts, label).not.toBe('ok')
      expect(rustCode(f, toCli(cred)), label).toBe(ts)
    }
  })

  it('a large payload (3 MiB) survives', () => {
    const big = randomBytes(3 * 1024 * 1024)
    const f = encodeTransfer({ kind: 'export', account, master, vault, dbFile: big, appVersion: '0.0.0-parity', schemaVersion: SCHEMA_VERSION })
    expect(rustOpen(f, ['password', PASSWORD]).dbSha256).toBe(sha(big))
  })
})

describe('.kasboek written by Rust, read by TS', () => {
  const spec = (over: Record<string, unknown> = {}) => {
    writeFileSync(
      file('spec.json'),
      JSON.stringify({
        kind: 'export',
        createdAt: '2026-01-02T03:04:05.678Z',
        appVersion: '0.0.0-parity',
        schemaVersion: SCHEMA_VERSION,
        mode: account.mode,
        twoFactor: account.twoFactor,
        passwordSlot: account.slots.password,
        recoverySlot: account.slots.recovery,
        masterHex: master.toString('hex'),
        vault,
        ...over
      })
    )
    cli(['transfer-make', file('spec.json'), file('payload.db'), file('rust.kasboek')])
    return readFileSync(file('rust.kasboek'))
  }

  it('TS opens it with the password and with the recovery key', async () => {
    const f = spec()
    const byPassword = await openTransfer(f, { password: PASSWORD })
    expect(byPassword.master.equals(master)).toBe(true)
    expect(byPassword.vault).toEqual(vault)
    expect(byPassword.dbFile.equals(dbFile)).toBe(true)
    expect(byPassword.usedRecovery).toBe(false)
    const byRecovery = await openTransfer(f, { recoveryKey })
    expect(byRecovery.usedRecovery).toBe(true)
    expect(byRecovery.dbFile.equals(dbFile)).toBe(true)
    await expect(openTransfer(f, { password: 'nope' })).rejects.toMatchObject({ code: 'transfer.wrong_credentials' })
  })

  it('the header is byte-for-byte what JSON.stringify of the same header gives', () => {
    const f = spec({ kind: 'backup' })
    const len = f.readUInt32BE(8)
    const headerText = f.subarray(12, 12 + len).toString('utf8')
    const header = readTransferHeader(f) as TransferHeader
    expect(header.kind).toBe('backup')
    expect(headerText).toBe(JSON.stringify(header))
    expect(Object.keys(header)).toEqual(['format', 'kind', 'createdAt', 'appVersion', 'schemaVersion', 'mode', 'twoFactor', 'slots', 'salt', 'iv'])
    expect(Object.keys(header.slots)).toEqual(['recovery', 'password'])
  })

  it('passwordless and 2FA exports', async () => {
    const pwless = spec({ mode: 'device', passwordSlot: null })
    expect(readTransferHeader(pwless).slots.password).toBeUndefined()
    await expect(openTransfer(pwless, { password: PASSWORD })).rejects.toMatchObject({ code: 'transfer.needs_recovery' })
    expect((await openTransfer(pwless, { recoveryKey })).master.equals(master)).toBe(true)

    const totp = { secret: TOTP_SECRET, lastStep: -1 }
    const f = spec({ twoFactor: true, vault: { ...vault, totp } })
    await expect(openTransfer(f, { password: PASSWORD })).rejects.toMatchObject({ code: 'transfer.wrong_credentials' })
    const opened = await openTransfer(f, { password: PASSWORD, code: totpAt(TOTP_SECRET, Date.now() / 1000) })
    expect(opened.vault.totp?.lastStep).toBeGreaterThan(0)
  })
})

describe('.kbsync', () => {
  const key = Buffer.from('7c'.repeat(32), 'hex')
  const KEY = key.toString('hex')
  const header = { v: 1, account: 'invented-account', device: 'dev-a', seq: 7 }
  const payload = {
    changes: Array.from({ length: 300 }, (_, i) => ({ tbl: 'transactions', uid: `uid-${i}`, data: { description: `Invented ✓ ${i}`, amount_cents: i * 37 - 5000, ratio: i / 8, nothing: null, flag: i % 2 === 0 } })),
    text: 'zażółć gęślą jaźń — 日本語 — 🧾'
  }

  it('TS seals, Rust opens: same decoded JSON', () => {
    const f = sealSyncFile(key, header, payload)
    writeFileSync(file('a.kbsync'), f)
    expect(cli(['sync-open', KEY, file('a.kbsync')], { device: 'dev-a', seq: 7 })).toEqual(payload)
    expect(cli(['sync-open', KEY, file('a.kbsync')], {})).toEqual(payload)
  })

  it('Rust seals, TS opens: same decoded JSON', () => {
    cli(['sync-make', KEY, file('b.kbsync')], { header, payload })
    const f = readFileSync(file('b.kbsync'))
    expect(f.subarray(0, 8).toString()).toBe('KBSYNC1\n')
    expect(openSyncFile(key, f, { device: 'dev-a', seq: 7 })).toEqual(payload)
    // The header is written compactly and in the given order, like JSON.stringify does.
    const hl = f.readUInt32BE(8)
    expect(f.subarray(12, 12 + hl).toString()).toBe(JSON.stringify(header))
  })

  it('header expectations: a different value, a missing key, a different type are refused on both sides', () => {
    const f = sealSyncFile(key, header, payload)
    writeFileSync(file('c.kbsync'), f)
    for (const expect_ of [{ device: 'dev-b' }, { nope: 1 }, { seq: '7' }, { seq: 8 }]) {
      expect(() => openSyncFile(key, f, expect_)).toThrow(/mismatch/)
      expect(() => cli(['sync-open', KEY, file('c.kbsync')], expect_)).toThrow(/mismatch/)
    }
  })

  it('wrong key, changed bytes, truncation and foreign files are refused on both sides', () => {
    const f = sealSyncFile(key, header, payload)
    const wrongKey = Buffer.alloc(32, 1)
    const bad: [string, Buffer, Buffer][] = [['wrong key', f, wrongKey]]
    for (const at of [3, 11, 14, 40, f.length - 1]) {
      const c = Buffer.from(f)
      c[at]! ^= 1
      bad.push([`flipped byte ${at}`, c, key])
    }
    bad.push(['truncated', f.subarray(0, f.length - 20), key])
    bad.push(['too short', f.subarray(0, 30), key])
    bad.push(['foreign', Buffer.concat([Buffer.from('KASBOEK2'), randomBytes(80)]), key])
    for (const [label, bytes, k] of bad) {
      writeFileSync(file('d.kbsync'), bytes)
      expect(() => openSyncFile(k, bytes, {}), `TS ${label}`).toThrow()
      expect(() => cli(['sync-open', k.toString('hex'), file('d.kbsync')], {}), `Rust ${label}`).toThrow()
    }
  })

  it('header length claims are handled: a header longer than the file is refused', () => {
    const f = sealSyncFile(key, header, payload)
    const c = Buffer.from(f)
    c.writeUInt32BE(f.length, 8)
    writeFileSync(file('e.kbsync'), c)
    expect(() => openSyncFile(key, c, {})).toThrow()
    expect(() => cli(['sync-open', key.toString('hex'), file('e.kbsync')], {})).toThrow()
  })
})
