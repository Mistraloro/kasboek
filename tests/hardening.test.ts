import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPasswordKdfForTests } from '@core/crypto'
import { openDatabase } from '@core/database'
import { insertTransaction, transactionsCsv } from '@core/finance'
import { DEFAULT_SETTINGS, getSettings, resetImportedSettings, updateSettings } from '@core/settings'
import { setSecret, getSecret } from '@core/secrets'
import { PUBLIC_OPS } from '@shared/contract'
import { checksumFromSums, safeAssetName } from '@core/update'
import { purgeErased, quarantineData, restoreErased, listErased, type DataLayout } from '../src/main/quarantine'
import { isDevRendererUrl, isTrustedFrameUrl } from '../src/main/trusted-url'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'kb-hard-'))
function openDb() {
  return openDatabase(join(tempDir(), 'k.db'), randomBytes(32).toString('hex'))
}

describe('CSV export: formulas are neutralised', () => {
  it('prefixes a quote on text that starts like a formula, never on dates or amounts', () => {
    const d = openDb()
    const a = Number(d.prepare("INSERT INTO accounts (name) VALUES ('=Main')").run().lastInsertRowid)
    insertTransaction(d, { accountId: a, bookingDate: '2026-10-05', amountCents: -1250, counterpartyName: '=HYPERLINK("http://x","y")', description: '+1+1', communication: '@SUM(A1)', notes: '-2+3' })
    insertTransaction(d, { accountId: a, bookingDate: '2026-10-06', amountCents: 500, counterpartyName: '\tTab', description: 'Fine = ok' })
    const labels = ['Date', 'Account', 'Counterparty', 'IBAN', 'Description', 'Message', 'Category', 'Amount', 'Currency', 'Notes']
    const lines = transactionsCsv(d, {}, { decimal: '.', labels }).csv.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[1]).toBe(`2026-10-05,'=Main,"'=HYPERLINK(""http://x"",""y"")",,'+1+1,'@SUM(A1),,-12.50,EUR,'-2+3`)
    expect(lines[2]).toBe(`2026-10-06,'=Main,'\tTab,,Fine = ok,,,5.00,EUR,`)
  })
})

describe('update checksums and file names', () => {
  const h1 = 'a'.repeat(64)
  const h2 = 'B'.repeat(64)
  it('compares the whole file name', () => {
    const sums = `${h1}  Kasboek-0.1.0-win-x64.msi\r\n${h2} *Kasboek-0.1.0-arm64.deb\n`
    expect(checksumFromSums(sums, 'Kasboek-0.1.0-win-x64.msi')).toBe(h1)
    expect(checksumFromSums(sums, 'Kasboek-0.1.0-arm64.deb')).toBe('b'.repeat(64))
    // A longer name that merely ends the same way must not match.
    expect(checksumFromSums(`${h1}  evil-Kasboek-0.1.0-win-x64.msi\n`, 'Kasboek-0.1.0-win-x64.msi')).toBeNull()
    expect(checksumFromSums(`${h1}  dir/Kasboek-0.1.0-win-x64.msi\n`, 'Kasboek-0.1.0-win-x64.msi')).toBeNull()
    expect(checksumFromSums('nothing useful', 'x.msi')).toBeNull()
    expect(checksumFromSums(`${'z'.repeat(64)}  x.msi`, 'x.msi')).toBeNull()
  })
  it('accepts plain names only', () => {
    expect(safeAssetName('Kasboek-0.14.1-win-x64.msi')).toBe(true)
    expect(safeAssetName('Kasboek_0.14.1-x86_64.AppImage')).toBe(true)
    for (const bad of ['', '..', 'a b.msi', 'a"&calc.msi', 'a\\b.msi', 'a/b.msi', 'a%20b.msi', 'é.msi', 'a\nb.msi', 'a;b.msi']) expect(safeAssetName(bad)).toBe(false)
  })
})

describe('trusted pages', () => {
  const dir = join(tempDir(), 'renderer')
  const base = pathToFileURL(dir).href
  it('accepts files inside the renderer folder only', () => {
    expect(isTrustedFrameUrl(`${base}/index.html`, dir, undefined, true)).toBe(true)
    expect(isTrustedFrameUrl(`${base}/assets/a.js?x=1#y`, dir, undefined, true)).toBe(true)
    // A sibling folder that starts with the same text.
    expect(isTrustedFrameUrl(`${base}-evil/index.html`, dir, undefined, true)).toBe(false)
    expect(isTrustedFrameUrl(`${base}/../other/index.html`, dir, undefined, true)).toBe(false)
    expect(isTrustedFrameUrl('https://example.com/', dir, undefined, true)).toBe(false)
    expect(isTrustedFrameUrl('not a url', dir, undefined, true)).toBe(false)
    expect(isTrustedFrameUrl(`${base}/index.html`, '', undefined, true)).toBe(false)
  })
  it('honours the dev server by origin, and only when not packaged', () => {
    const dev = 'http://localhost:5173/'
    expect(isTrustedFrameUrl('http://localhost:5173/index.html', dir, dev, false)).toBe(true)
    expect(isTrustedFrameUrl('http://localhost:5173/index.html', dir, dev, true)).toBe(false)
    expect(isTrustedFrameUrl('http://localhost:5173.evil.com/', dir, dev, false)).toBe(false)
    expect(isTrustedFrameUrl('http://localhost:51730/', dir, dev, false)).toBe(false)
    expect(isDevRendererUrl('http://localhost:5173/x', dev, true)).toBe(false)
    expect(isDevRendererUrl('http://localhost:5173/x', undefined, false)).toBe(false)
  })
})

describe('imported settings', () => {
  it('resets where data goes and what Claude may do, and keeps the rest', () => {
    const d = openDb()
    updateSettings(d, { currency: 'USD', aiProvider: 'custom', aiBaseUrl: 'https://evil.example/v1', mcpEnabled: true, autoBackupFolder: '/tmp/x', permissions: { mode: 'auto', rules: {}, mcpAlwaysAsk: false } as never, autoBackupKeep: 3 })
    setSecret(d, 'anthropicApiKey', 'sk-ant-x')
    setSecret(d, 'aiKey.custom', 'k')
    setSecret(d, 'syncKey', 'keep')
    resetImportedSettings(d)
    const s = getSettings(d)
    expect(s.currency).toBe('USD')
    expect(s.autoBackupKeep).toBe(3)
    for (const k of ['aiProvider', 'aiBaseUrl', 'mcpEnabled', 'autoBackupFolder', 'permissions'] as const) expect(s[k]).toEqual(DEFAULT_SETTINGS[k])
    expect(getSecret(d, 'anthropicApiKey')).toBeNull()
    expect(getSecret(d, 'aiKey.custom')).toBeNull()
    expect(getSecret(d, 'syncKey')).toBe('keep')
  })
})

describe('which operations work while locked', () => {
  it('lets the first screen erase and restore, but deleting erased data for good needs a login', () => {
    expect(PUBLIC_OPS).toContain('auth.erase')
    expect(PUBLIC_OPS).toContain('auth.restoreErased')
    expect(PUBLIC_OPS).not.toContain('auth.deleteErasedNow')
  })
})

describe('erase quarantine', () => {
  const layout = (): DataLayout => {
    const dataDir = tempDir()
    return { dataDir, dbFile: join(dataDir, 'kasboek.db'), accountFile: join(dataDir, 'account.json'), legacyKeystoreFile: join(dataDir, 'keystore.json'), safetyDir: join(dataDir, 'safety-backups') }
  }
  const fill = (l: DataLayout): void => {
    writeFileSync(l.dbFile, 'db')
    writeFileSync(l.accountFile, 'account')
    mkdirSync(l.safetyDir)
    writeFileSync(join(l.safetyDir, 'before-import-1.kasboek'), 'safe')
  }
  const DAY = 86_400_000

  it('moves the data aside instead of deleting it, and restores it', async () => {
    const l = layout()
    fill(l)
    const name = await quarantineData(l, 1_000_000_000_000)
    expect(name).toBe('1000000000000')
    expect(existsSync(l.dbFile) || existsSync(l.accountFile) || existsSync(l.safetyDir)).toBe(false)
    const entry = join(l.dataDir, 'erased', name!)
    expect(readFileSync(join(entry, 'kasboek.db'), 'utf8')).toBe('db')
    expect(readFileSync(join(entry, 'safety-backups', 'before-import-1.kasboek'), 'utf8')).toBe('safe')
    expect((await listErased(l)).map((e) => e.erasedAt)).toEqual([1_000_000_000_000])

    await restoreErased(l)
    expect(readFileSync(l.dbFile, 'utf8')).toBe('db')
    expect(readFileSync(l.accountFile, 'utf8')).toBe('account')
    expect(readFileSync(join(l.safetyDir, 'before-import-1.kasboek'), 'utf8')).toBe('safe')
    expect(await listErased(l)).toEqual([])
  })

  it('refuses to restore over a live account, and when nothing was erased', async () => {
    const l = layout()
    await expect(restoreErased(l)).rejects.toMatchObject({ code: 'auth.nothing_erased' })
    fill(l)
    await quarantineData(l)
    writeFileSync(l.accountFile, 'new account')
    await expect(restoreErased(l)).rejects.toMatchObject({ code: 'auth.restore_blocked' })
    expect(readFileSync(l.accountFile, 'utf8')).toBe('new account')
    expect(await listErased(l)).toHaveLength(1)
  })

  it('keeps a newer database and safety copies that appeared after the erase', async () => {
    const l = layout()
    fill(l)
    await quarantineData(l)
    writeFileSync(l.dbFile, 'orphan')
    mkdirSync(l.safetyDir)
    writeFileSync(join(l.safetyDir, 'before-import-1.kasboek'), 'newer')
    await restoreErased(l)
    expect(readFileSync(l.dbFile, 'utf8')).toBe('db')
    expect(readFileSync(join(l.safetyDir, 'before-import-1.kasboek'), 'utf8')).toBe('newer')
    expect(readFileSync(join(l.safetyDir, 'restored-before-import-1.kasboek'), 'utf8')).toBe('safe')
  })

  it('makes no entry when there is nothing to move', async () => {
    const l = layout()
    expect(await quarantineData(l)).toBeNull()
    expect(await listErased(l)).toEqual([])
  })

  it('purges after 30 days (safety copies go back), or everything on request', async () => {
    const l = layout()
    fill(l)
    const t0 = 1_800_000_000_000
    await quarantineData(l, t0)
    expect(await purgeErased(l, { now: t0 + 29 * DAY })).toBe(0)
    expect(await listErased(l)).toHaveLength(1)
    expect(await purgeErased(l, { now: t0 + 31 * DAY })).toBe(1)
    expect(await listErased(l)).toEqual([])
    expect(existsSync(l.dbFile) || existsSync(l.accountFile)).toBe(false)
    expect(readFileSync(join(l.safetyDir, 'before-import-1.kasboek'), 'utf8')).toBe('safe')

    const m = layout()
    fill(m)
    await quarantineData(m, t0)
    expect(await purgeErased(m, { all: true, now: t0 })).toBe(1)
    expect(existsSync(m.safetyDir)).toBe(false)
    expect(await listErased(m)).toEqual([])
  })
})

/* ---------- Session: login state with the operating system parts mocked ---------- */

const mocks = vi.hoisted(() => ({
  dataDir: '',
  saveAccount: vi.fn(),
  keyProtection: vi.fn(),
  deviceKind: vi.fn(),
  verify: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.dataDir, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 }
}))
vi.mock('../src/main/security/account-store', () => ({
  accountExists: () => false,
  keyProtection: mocks.keyProtection,
  loadAccount: async () => null,
  readLegacyDbKey: async () => null,
  removeLegacyKeystore: async () => undefined,
  saveAccount: mocks.saveAccount
}))
vi.mock('../src/main/security/device-auth', () => ({
  deviceAuthKind: mocks.deviceKind,
  peekDeviceAuthKind: () => null,
  verifyDeviceUser: mocks.verify
}))
vi.mock('../src/main/prefs', () => ({ getPrefs: () => ({ autoLockMinutes: 0 }) }))

const PASSWORD = 'a long strong passphrase 2026!'

describe('session', () => {
  let session: typeof import('../src/main/session')
  beforeEach(async () => {
    mocks.dataDir = tempDir()
    mocks.saveAccount.mockReset().mockResolvedValue(undefined)
    mocks.keyProtection.mockReset().mockResolvedValue('os')
    mocks.deviceKind.mockReset().mockResolvedValue('windows-hello')
    mocks.verify.mockReset().mockResolvedValue(true)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.resetModules()
    session = await import('../src/main/session')
  })
  const failures = () => session.secrets().account.attempts.failed

  it('refuses passwordless mode without operating system key protection', async () => {
    mocks.keyProtection.mockResolvedValue('weak')
    await expect(session.setup('device')).rejects.toMatchObject({ code: 'auth.device_unprotected' })
    expect(mocks.saveAccount).not.toHaveBeenCalled()
    expect(session.isUnlocked()).toBe(false)

    mocks.keyProtection.mockResolvedValue('os')
    await session.setup('password', PASSWORD)
    mocks.keyProtection.mockResolvedValue('weak')
    await expect(session.switchToPasswordless(PASSWORD)).rejects.toMatchObject({ code: 'auth.device_unprotected' })
    expect(session.secrets().account.mode).toBe('password')
    expect(failures()).toBe(0)

    mocks.keyProtection.mockResolvedValue('os')
    await session.switchToPasswordless(PASSWORD)
    expect(session.secrets().account.mode).toBe('device')
  })

  it('throttles wrong passwords in sensitive changes like at unlock, and resets on success', async () => {
    await session.setup('password', PASSWORD)
    for (let i = 0; i < 5; i++) await expect(session.newRecoveryKey('wrong')).rejects.toMatchObject({ code: 'auth.failed' })
    expect(failures()).toBe(5)
    // Even the right password waits now.
    await expect(session.newRecoveryKey(PASSWORD)).rejects.toMatchObject({ code: 'auth.throttled' })
    await expect(session.changePassword(PASSWORD, 'another strong passphrase 2027!')).rejects.toMatchObject({ code: 'auth.throttled' })
    await expect(session.switchToPasswordless(PASSWORD)).rejects.toMatchObject({ code: 'auth.throttled' })
    expect((await session.status()).throttleSeconds).toBeGreaterThan(0)
  })

  it('resets the counter after a correct password', async () => {
    await session.setup('password', PASSWORD)
    await expect(session.newRecoveryKey('wrong')).rejects.toMatchObject({ code: 'auth.failed' })
    await expect(session.newRecoveryKey('wrong')).rejects.toMatchObject({ code: 'auth.failed' })
    expect(failures()).toBe(2)
    await session.newRecoveryKey(PASSWORD)
    expect(session.secrets().account.attempts.failed).toBe(0)
  })

  it('keeps the old account in memory when saving fails, but still counts a failed guess', async () => {
    await session.setup('password', PASSWORD)
    const before = session.secrets().account
    mocks.saveAccount.mockRejectedValue(new Error('EACCES: disk full'))
    await expect(session.changePassword(PASSWORD, 'another strong passphrase 2027!')).rejects.toThrow('EACCES')
    expect(session.secrets().account).toBe(before)

    // A wrong password: the counter goes up in memory and the error is the login error, not the disk error.
    await expect(session.newRecoveryKey('wrong')).rejects.toMatchObject({ code: 'auth.failed' })
    expect(failures()).toBe(1)
    session.lock('user', true)
    await expect(session.unlock({ password: 'wrong' })).rejects.toMatchObject({ code: 'auth.failed' })
    await expect(session.unlock({ password: 'wrong' })).rejects.toMatchObject({ code: 'auth.failed' })
    expect((await session.status()).state).toBe('locked')
    // And a correct login still works when only the counter write fails.
    await session.unlock({ password: PASSWORD })
    expect(session.isUnlocked()).toBe(true)
    expect(failures()).toBe(0)
  })

  it('needs the device check to erase a passwordless account, and moves the data aside', async () => {
    mocks.dataDir = tempDir()
    await session.setup('device')
    expect(existsSync(join(mocks.dataDir, 'kasboek.db'))).toBe(true)
    mocks.verify.mockResolvedValue(false)
    await expect(session.erase()).rejects.toMatchObject({ code: 'auth.device_failed' })
    expect(session.isUnlocked()).toBe(true)
    mocks.verify.mockResolvedValue(true)
    await session.erase()
    expect(existsSync(join(mocks.dataDir, 'kasboek.db'))).toBe(false)
    expect(existsSync(join(mocks.dataDir, 'erased'))).toBe(true)
    expect((await session.status()).state).toBe('setup')
    expect((await session.status()).erasedAt).not.toBeNull()
  })

  it('deleting erased data for good needs an unlocked session and the password', async () => {
    await session.setup('password', PASSWORD)
    await session.erase()
    await expect(session.deleteErasedNow(PASSWORD)).rejects.toMatchObject({ code: 'auth.locked' })
    await session.setup('password', PASSWORD)
    expect((await session.status()).erasedAt).not.toBeNull()
    await expect(session.deleteErasedNow('wrong')).rejects.toMatchObject({ code: 'auth.failed' })
    expect((await session.status()).erasedAt).not.toBeNull()
    await session.deleteErasedNow(PASSWORD)
    expect((await session.status()).erasedAt).toBeNull()
  })
})
