import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '@core/account'
import { setPasswordKdfForTests } from '@core/crypto'
import { openDatabase, snapshotEncrypted } from '@core/database'
import { sealSyncFile } from '@core/sync-file'
import { encodeTransfer } from '@core/transfer-format'
import { totpAt as nodeTotp } from '@core/totp'
import * as portable from '@core/portable'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))

/** What a mobile app gets from a desktop file must equal what the desktop put in. */
describe('portable reader (WebCrypto only, for mobile)', () => {
  async function exportFile(twoFactor: boolean) {
    const dbKey = randomBytes(32).toString('hex')
    const dir = mkdtempSync(join(tmpdir(), 'kb-portable-'))
    const db = openDatabase(join(dir, 'k.db'), dbKey)
    db.prepare("INSERT INTO secrets (key, value) VALUES ('syncKey', ?)").run(randomBytes(32).toString('hex'))
    snapshotEncrypted(db, join(dir, 'copy.db'))
    db.close()
    const made = await createAccount({ mode: 'password', password: 'a long password', dbKey })
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    const account = twoFactor ? { ...made.account, twoFactor: true } : made.account
    const vault = twoFactor ? { ...made.vault, totp: { secret: totpSecret, lastStep: 0 } } : made.vault
    const dbFile = readFileSync(join(dir, 'copy.db'))
    const file = encodeTransfer({ kind: 'export', account, master: made.master, vault, dbFile, appVersion: '0.14.0', schemaVersion: 12 })
    return { file: new Uint8Array(file), made, dbFile, dbKey, totpSecret }
  }

  it('opens an export with the password, or the recovery key', async () => {
    const { file, made, dbFile, dbKey } = await exportFile(false)
    const a = await portable.openTransfer(file, { password: 'a long password' })
    expect(Buffer.from(a.master).equals(made.master)).toBe(true)
    expect(a.vault.dbKey).toBe(dbKey)
    expect(Buffer.from(a.dbFile).equals(dbFile)).toBe(true)
    const b = await portable.openTransfer(file, { recoveryKey: made.recoveryKey.toLowerCase().replaceAll('-', ' ') })
    expect(b.usedRecovery).toBe(true)
    await expect(portable.openTransfer(file, { password: 'wrong password' })).rejects.toThrow()
  })

  it('checks the 2FA code like the desktop does', async () => {
    const { file, totpSecret } = await exportFile(true)
    const step = Math.floor(Date.now() / 30000)
    expect(await portable.totpAt(totpSecret, step)).toBe(nodeTotp(totpSecret, step * 30))
    await expect(portable.openTransfer(file, { password: 'a long password' })).rejects.toThrow()
    const ok = await portable.openTransfer(file, { password: 'a long password', code: nodeTotp(totpSecret, Date.now() / 1000) })
    expect(ok.vault.totp?.secret).toBe(totpSecret)
  })

  it('opens sync files and checks their header', async () => {
    const key = randomBytes(32)
    const changes = [{ t: 'transactions', id: 'x', data: { description: 'Café ☕', amount_cents: -450 } }]
    const header = { kind: 'changes', groupId: 'g1', device: 'abcdef12', seq: 3 }
    // A Node Buffer as is (a view into a shared block), as the desktop has it.
    const file = sealSyncFile(key, header, changes)
    expect(await portable.openSyncFile(key.toString('hex'), file, header)).toEqual(changes)
    await expect(portable.openSyncFile(key.toString('hex'), file, { ...header, seq: 4 })).rejects.toThrow()
    await expect(portable.openSyncFile(randomBytes(32).toString('hex'), file, header)).rejects.toThrow()
  })
})
