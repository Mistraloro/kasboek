/**
 * Login state. While locked, the database is closed and no key is held in memory.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { BrowserWindow, powerMonitor } from 'electron'
import QRCode from 'qrcode'
import {
  createAccount,
  forgetRemembered,
  rememberedUntil,
  rotateRecoveryKey,
  setPassword,
  setPasswordless,
  setTwoFactor,
  storeVault,
  throttleSeconds,
  unlockWithDevice,
  unlockWithPassword,
  unlockWithRecovery,
  type AccountData,
  type AuthMode,
  type Vault
} from '@core/account'
import { openSlot } from '@core/crypto'
import { openDatabase, type Db } from '@core/database'
import { AppError } from '@core/errors'
import { newTotpSecret, otpauthUri, verifyTotp } from '@core/totp'
import type { AppEvent } from '@shared/contract'
import { checkPassword } from '@shared/password'
import type { AuthStatus } from '@shared/types'
import { paths } from './paths'
import { getPrefs } from './prefs'
import { accountExists, deleteAccount, keyProtection, loadAccount, readLegacyDbKey, removeLegacyKeystore, saveAccount } from './security/account-store'
import { deviceAuthKind, peekDeviceAuthKind, verifyDeviceUser } from './security/device-auth'

interface Open {
  master: Buffer
  vault: Vault
  db: Db
}

let account: AccountData | null = null
let loadError: AppError | null = null
let open: Open | null = null
/** Unlocked with the recovery key: the next password change needs no current password. */
let recovered = false
let pendingTotp: string | null = null
/** Unlocked with a password that predates the current rules. */
let weakPassword = false
const lockListeners: (() => void)[] = []

export function broadcast(event: AppEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('kasboek:event', event)
}

export function onLock(fn: () => void): void {
  lockListeners.push(fn)
}

export async function initSession(): Promise<void> {
  loadError = null
  try {
    account = await loadAccount()
  } catch (err) {
    loadError = err instanceof AppError ? err : new AppError('auth.corrupt', String(err))
  }
  // Checking for Windows Hello takes a moment (PowerShell): never let the first screen wait for it.
  peekDeviceAuthKind(() => broadcast({ type: 'auth.refresh' }))
}

export function db(): Db {
  if (!open) throw new AppError('auth.locked', 'Kasboek is locked.')
  return open.db
}

export function isUnlocked(): boolean {
  return open !== null
}

/** For exports and backups while unlocked. */
export function secrets(): { account: AccountData; master: Buffer; vault: Vault } {
  if (!open || !account) throw new AppError('auth.locked', 'Kasboek is locked.')
  return { account, master: open.master, vault: open.vault }
}

export async function status(): Promise<AuthStatus> {
  // "Try again" after e.g. unlocking the system keyring.
  if (loadError && !open) await initSession()
  const peek = peekDeviceAuthKind(() => broadcast({ type: 'auth.refresh' }))
  const device = peek ?? null
  return {
    // An account file that can't be read is 'locked' with an error, never 'setup': setup would replace it.
    state: open ? 'unlocked' : account || loadError ? 'locked' : 'setup',
    mode: account?.mode ?? null,
    twoFactor: account?.twoFactor ?? false,
    rememberedUntil: account ? rememberedUntil(account) : null,
    device,
    deviceChecking: peek === undefined,
    throttleSeconds: account ? throttleSeconds(account) : 0,
    recovered,
    weakPassword: !!open && weakPassword,
    legacyData: !account && (await readLegacyDbKey()) !== null,
    keyProtection: await keyProtection(),
    error: loadError ? { code: loadError.code, message: loadError.message } : null
  }
}

function openWith(master: Buffer, vault: Vault): void {
  const database = openDatabase(paths.dbFile, vault.dbKey)
  open = { master, vault, db: database }
}

async function persist(next: AccountData): Promise<void> {
  account = next
  await saveAccount(next)
}

async function requireDevice(reason: string): Promise<void> {
  if (!(await deviceAuthKind())) throw new AppError('auth.no_device', 'Windows Hello or Touch ID is not available on this computer.')
  if (!(await verifyDeviceUser(reason))) throw new AppError('auth.device_failed', 'Verification was cancelled or failed.')
}

/* ---------- Setup, unlock, lock ---------- */

export async function setup(mode: AuthMode, password?: string): Promise<{ recoveryKey: string }> {
  if (account || loadError || accountExists()) throw new AppError('auth.exists', 'Kasboek is already set up.')
  if (mode === 'password' && !checkPassword(password ?? '').ok) throw new AppError('auth.weak_password', 'Choose a stronger password.')
  if (mode === 'device') await requireDevice('Set up Kasboek')
  const legacyKey = await readLegacyDbKey()
  if (!legacyKey && existsSync(paths.dbFile)) {
    // A database without its account can't be opened by anyone: move it aside, don't delete it.
    await rename(paths.dbFile, `${paths.dbFile}.orphaned-${Date.now()}`)
  }
  const created = await createAccount({ mode, password, dbKey: legacyKey ?? randomBytes(32).toString('hex') })
  await persist(created.account)
  openWith(created.master, created.vault)
  if (legacyKey) await removeLegacyKeystore()
  return { recoveryKey: created.recoveryKey }
}

function requireAccount(): AccountData {
  if (!account) throw loadError ?? new AppError('auth.no_account', 'Set up Kasboek first.')
  return account
}

export async function unlock(input: { password?: string; code?: string; remember?: boolean }): Promise<void> {
  const acc = requireAccount()
  let result
  if (acc.mode === 'device') {
    // Check the 2FA code format first so a typo doesn't cost a Hello prompt.
    const needCode = acc.twoFactor && !rememberedUntil(acc)
    if (needCode && !/^\d{6}$/.test((input.code ?? '').trim())) throw new AppError('auth.code_required', 'Enter the 6-digit code from your authenticator app.')
    await requireDevice('Unlock Kasboek')
    result = unlockWithDevice(acc, input.code || undefined, { remember: input.remember })
  } else {
    result = await unlockWithPassword(acc, input.password ?? '', input.code || undefined, { remember: input.remember })
  }
  await persist(result.account)
  if (!result.ok) {
    throw new AppError('auth.failed', acc.twoFactor ? 'The password or code is incorrect.' : 'The password is incorrect.')
  }
  recovered = false
  weakPassword = acc.mode === 'password' && !checkPassword(input.password ?? '').ok
  openWith(result.unlocked.master, result.unlocked.vault)
}

export async function unlockRecovery(recoveryKey: string): Promise<void> {
  const result = await unlockWithRecovery(requireAccount(), recoveryKey)
  await persist(result.account)
  if (!result.ok) throw new AppError('auth.failed', 'That recovery key is not correct.')
  recovered = true
  openWith(result.unlocked.master, result.unlocked.vault)
}

export function lock(reason: 'user' | 'idle' | 'system' = 'user', silent = false): void {
  if (!open) return
  for (const fn of lockListeners) fn()
  open.db.close()
  open.master.fill(0)
  open = null
  pendingTotp = null
  recovered = false
  weakPassword = false
  if (!silent) broadcast({ type: 'auth.locked', reason })
}

/** Closes the database without telling the UI, e.g. right before an import replaces it. */
export function closeForReplace(): void {
  lock('user', true)
}

export async function erase(): Promise<void> {
  lock('user')
  await rm(paths.dbFile, { force: true })
  await rm(paths.safetyDir, { recursive: true, force: true })
  await deleteAccount()
  await removeLegacyKeystore()
  account = null
  loadError = null
}

/** Re-checks who is at the keyboard before a sensitive change. */
async function reauth(password?: string): Promise<void> {
  const acc = requireAccount()
  if (recovered) return
  if (acc.mode === 'device') return requireDevice('Confirm it is you')
  if (!password || !acc.slots.password || !(await openSlot(acc.slots.password, password, 'password'))) {
    throw new AppError('auth.failed', 'The current password is incorrect.')
  }
}

export async function changePassword(current: string | undefined, next: string): Promise<void> {
  const { master } = secrets()
  await reauth(current)
  if (!checkPassword(next).ok) throw new AppError('auth.weak_password', 'Choose a stronger password.')
  await persist(await setPassword(requireAccount(), master, next))
  recovered = false
  weakPassword = false
}

export async function switchToPasswordless(currentPassword?: string): Promise<void> {
  const { master } = secrets()
  await reauth(currentPassword)
  await requireDevice('Use Windows Hello or Touch ID for Kasboek')
  await persist(setPasswordless(requireAccount(), master))
  recovered = false
}

export async function newRecoveryKey(password?: string): Promise<string> {
  const { master } = secrets()
  await reauth(password)
  const r = await rotateRecoveryKey(requireAccount(), master)
  await persist(r.account)
  return r.recoveryKey
}

export async function forgetThisComputer(): Promise<void> {
  secrets()
  await persist(forgetRemembered(requireAccount()))
}

export async function totpBegin(): Promise<{ secret: string; uri: string; qrSvg: string }> {
  secrets()
  pendingTotp = newTotpSecret()
  const uri = otpauthUri(pendingTotp)
  const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#18201B', light: '#FFFFFF' } })
  return { secret: pendingTotp.match(/.{1,4}/g)!.join(' '), uri, qrSvg }
}

export async function totpEnable(code: string): Promise<void> {
  const { master, vault } = secrets()
  if (!pendingTotp) throw new AppError('auth.totp_expired', 'Start the set-up again.')
  const step = verifyTotp(pendingTotp, code, -1)
  if (step === null) throw new AppError('auth.failed', 'That code is not correct. Check the time on your phone and try again.')
  const r = setTwoFactor(requireAccount(), master, vault, { secret: pendingTotp, lastStep: step })
  pendingTotp = null
  open!.vault = r.vault
  await persist(r.account)
}

export async function totpDisable(code: string): Promise<void> {
  const { master, vault } = secrets()
  const step = vault.totp ? verifyTotp(vault.totp.secret, code, vault.totp.lastStep) : null
  if (step === null && !recovered) throw new AppError('auth.failed', 'That code is not correct.')
  const r = setTwoFactor(requireAccount(), master, vault, null)
  open!.vault = r.vault
  await persist(r.account)
}

/** Used by import: replaces the account and opens the imported database. */
export async function adopt(next: AccountData, master: Buffer, vault: Vault, wasRecovery: boolean): Promise<void> {
  if (open) closeForReplace()
  await persist(storeVault(next, master, vault))
  loadError = null
  openWith(master, vault)
  recovered = wasRecovery && next.mode === 'password'
}

/* ---------- Auto-lock ---------- */

export function startAutoLock(): void {
  setInterval(() => {
    const minutes = getPrefs().autoLockMinutes
    if (open && minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lock('idle')
  }, 15_000)
  powerMonitor.on('lock-screen', () => lock('system'))
  powerMonitor.on('suspend', () => lock('system'))
}
