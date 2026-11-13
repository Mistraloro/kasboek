import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAccount, setPasswordless, setTwoFactor, throttleSeconds, unlockWithDevice, unlockWithPassword, unlockWithRecovery } from '@core/account'
import { base32Encode, setPasswordKdfForTests } from '@core/crypto'
import { openDatabase, snapshotEncrypted } from '@core/database'
import { encodeTransfer, openTransfer, readTransferHeader } from '@core/transfer-format'
import { hotp, newTotpSecret, normalizeRecoveryKey, totpAt, verifyTotp } from '@core/totp'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))
const dbKey = () => randomBytes(32).toString('hex')

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors (SHA-1)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    expect(totpAt(secret, 59, 8)).toBe('94287082')
    expect(totpAt(secret, 1111111109, 8)).toBe('07081804')
    expect(totpAt(secret, 2000000000, 8)).toBe('69279037')
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224')
  })

  it('accepts one step of drift and rejects reuse', () => {
    const s = newTotpSecret()
    const now = 1_800_000_000
    const code = totpAt(s, now - 30)
    const step = verifyTotp(s, code, 0, now)
    expect(step).toBe(Math.floor(now / 30) - 1)
    expect(verifyTotp(s, code, step!, now)).toBeNull()
    expect(verifyTotp(s, totpAt(s, now - 90), 0, now)).toBeNull()
    expect(verifyTotp(s, 'abcdef', 0, now)).toBeNull()
  })
})

describe('account', () => {
  it('unlocks with the password or the recovery key, not with a wrong password', async () => {
    const key = dbKey()
    const { account, recoveryKey } = await createAccount({ mode: 'password', password: 'a long password', dbKey: key })
    expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)

    const good = await unlockWithPassword(account, 'a long password')
    expect(good.ok && good.unlocked.vault.dbKey).toBe(key)

    const bad = await unlockWithPassword(account, 'wrong password')
    expect(bad.ok).toBe(false)
    expect(bad.account.attempts.failed).toBe(1)

    const rec = await unlockWithRecovery(account, recoveryKey.toLowerCase().replace(/-/g, ' '))
    expect(rec.ok && rec.unlocked.vault.dbKey).toBe(key)
  })

  it('requires the 2FA code when enabled, and never says which factor was wrong', async () => {
    const created = await createAccount({ mode: 'password', password: 'a long password', dbKey: dbKey() })
    const secret = newTotpSecret()
    const { account } = setTwoFactor(created.account, created.master, created.vault, { secret, lastStep: 0 })
    expect((await unlockWithPassword(account, 'a long password')).ok).toBe(false)
    expect((await unlockWithPassword(account, 'a long password', '000000')).ok).toBe(false)
    expect((await unlockWithPassword(account, 'a long password', totpAt(secret, Date.now() / 1000))).ok).toBe(true)
  })

  it('works passwordless once the device has verified the user', async () => {
    const created = await createAccount({ mode: 'device', dbKey: dbKey() })
    const r = unlockWithDevice(created.account)
    expect(r.ok).toBe(true)
    await expect(unlockWithPassword(created.account, 'x')).rejects.toMatchObject({ code: 'auth.wrong_mode' })
    expect(setPasswordless(created.account, created.master).slots.device).toBeTruthy()
  })

  it('uses Argon2id for passwords and upgrades older scrypt slots on unlock', async () => {
    const { account, master } = await createAccount({ mode: 'password', password: 'a long password', dbKey: dbKey() })
    expect(account.slots.password!.kdf.name).toBe('argon2id')
    // Simulate a slot from an earlier version.
    const old = { ...account, slots: { ...account.slots, password: await legacyScryptSlot(master) } }
    const r = await unlockWithPassword(old, 'a long password')
    expect(r.ok).toBe(true)
    expect(r.account.slots.password!.kdf.name).toBe('argon2id')
  })

  it('slows down after five failures', async () => {
    const { account } = await createAccount({ mode: 'password', password: 'a long password', dbKey: dbKey() })
    const hammered = { ...account, attempts: { failed: 6, lastFailedAt: new Date().toISOString() } }
    expect(throttleSeconds(hammered)).toBeGreaterThan(50)
    await expect(unlockWithPassword(hammered, 'a long password')).rejects.toMatchObject({ code: 'auth.throttled' })
  })
})

describe('export file', () => {
  const build = async (opts: { twoFactor?: boolean; mode?: 'password' | 'device' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-x-'))
    const key = dbKey()
    const db = openDatabase(join(dir, 'live.db'), key)
    db.prepare("INSERT INTO accounts (name, bank) VALUES ('Argenta zicht', 'argenta')").run()
    snapshotEncrypted(db, join(dir, 'snap.db'))
    db.close()
    let { account, master, vault, recoveryKey } = await createAccount({ mode: opts.mode ?? 'password', password: 'a long password', dbKey: key })
    const secret = newTotpSecret()
    if (opts.twoFactor) ({ account, vault } = setTwoFactor(account, master, vault, { secret, lastStep: 0 }))
    const file = encodeTransfer({ kind: 'export', account, master, vault, dbFile: readFileSync(join(dir, 'snap.db')), appVersion: '0.2.0', schemaVersion: 1 })
    return { dir, file, recoveryKey, secret, key }
  }

  it('contains nothing readable and opens only with the right credentials', async () => {
    const { dir, file, recoveryKey, key } = await build()
    expect(file.includes(Buffer.from('Argenta zicht'))).toBe(false)
    expect(readTransferHeader(file).kind).toBe('export')
    await expect(openTransfer(file, { password: 'nope nope nope' })).rejects.toMatchObject({ code: 'transfer.wrong_credentials' })

    const out = await openTransfer(file, { password: 'a long password' })
    expect(out.vault.dbKey).toBe(key)
    writeFileSync(join(dir, 'in.db'), out.dbFile)
    const db = openDatabase(join(dir, 'in.db'), out.vault.dbKey)
    expect(db.prepare('SELECT name FROM accounts').get()).toEqual({ name: 'Argenta zicht' })
    db.close()

    expect((await openTransfer(file, { recoveryKey })).usedRecovery).toBe(true)
  })

  it('needs the 2FA code with the password, but not with the recovery key', async () => {
    const { file, secret, recoveryKey } = await build({ twoFactor: true })
    await expect(openTransfer(file, { password: 'a long password' })).rejects.toMatchObject({ code: 'transfer.wrong_credentials' })
    await expect(openTransfer(file, { password: 'a long password', code: totpAt(secret, Date.now() / 1000) })).resolves.toBeTruthy()
    await expect(openTransfer(file, { recoveryKey })).resolves.toBeTruthy()
  })

  it('passwordless exports need the recovery key', async () => {
    const { file, recoveryKey } = await build({ mode: 'device' })
    await expect(openTransfer(file, { password: 'a long password' })).rejects.toMatchObject({ code: 'transfer.needs_recovery' })
    await expect(openTransfer(file, { recoveryKey })).resolves.toBeTruthy()
  })

  it('detects a changed header (e.g. 2FA switched off)', async () => {
    const { file } = await build({ twoFactor: true })
    const forged = Buffer.from(file.toString('latin1').replace('"twoFactor":true', '"twoFactor":!!!!'), 'latin1')
    await expect(openTransfer(forged, { password: 'a long password', code: '123456' })).rejects.toBeTruthy()
    // Valid JSON that switches 2FA off: must still fail because the header is authenticated.
    const forged2 = Buffer.from(file.toString('latin1').replace('"twoFactor":true', '"twoFactor":0   '), 'latin1')
    expect(readTransferHeader(forged2).twoFactor).toBe(0)
    await expect(openTransfer(forged2, { password: 'a long password' })).rejects.toMatchObject({ code: 'transfer.corrupt' })
  })

  it('normalises recovery keys typed loosely', () => {
    expect(normalizeRecoveryKey('abcd efgh-2345')).toBe('ABCD-EFGH-2345')
  })
})

/** A password slot in the scrypt format earlier versions wrote. */
async function legacyScryptSlot(master: Buffer) {
  const { randomBytes, scryptSync } = await import('node:crypto')
  const { seal } = await import('@core/crypto')
  const salt = randomBytes(16)
  const key = scryptSync('a long password'.normalize('NFKC'), salt, 32, { N: 2 ** 10, r: 8, p: 1 })
  return { kdf: { name: 'scrypt' as const, N: 2 ** 10, r: 8, p: 1, salt: salt.toString('base64') }, sealed: seal(key, master, 'kasboek:slot:password') }
}

describe('remember 2FA for 30 days', () => {
  it('skips the code only with a valid, unexpired, unforged record, and clears on 2FA changes', async () => {
    const { rememberValid, setTwoFactor: set2fa } = await import('@core/account')
    const created = await createAccount({ mode: 'password', password: 'a long password', dbKey: dbKey() })
    const secret = newTotpSecret()
    const { account } = set2fa(created.account, created.master, created.vault, { secret, lastStep: 0 })
    const code = totpAt(secret, Date.now() / 1000)

    const first = await unlockWithPassword(account, 'a long password', code, { remember: true })
    expect(first.ok).toBe(true)
    const remembered = first.account
    expect(remembered.remember2fa).toBeTruthy()

    expect((await unlockWithPassword(remembered, 'a long password')).ok).toBe(true)
    expect((await unlockWithPassword(remembered, 'wrong password')).ok).toBe(false)

    const forged = { ...remembered, remember2fa: { until: '2099-01-01T00:00:00.000Z', mac: remembered.remember2fa!.mac } }
    expect(rememberValid(forged, created.master)).toBe(false)
    expect((await unlockWithPassword(forged, 'a long password')).ok).toBe(false)

    expect(rememberValid(remembered, created.master, Date.now() + 31 * 86_400_000)).toBe(false)

    const reset = set2fa(remembered, created.master, created.vault, { secret, lastStep: 0 }).account
    expect(reset.remember2fa).toBeUndefined()
  })
})
