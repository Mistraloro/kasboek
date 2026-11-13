/**
 * The local account: how the master key is unlocked, and what it protects.
 *
 *   password ─scrypt─┐
 *   recovery key ────┼─► master key ─► vault { database key, 2FA secret }
 *   device (OS) ─────┘
 *
 * Pure logic, no Electron. The main process adds the device seal (DPAPI/Keychain)
 * around the whole account record when it is written to disk.
 */
import { AppError } from './errors'
import { makeSlot, openSlot, random, seal, slotNeedsUpgrade, unseal, type Sealed, type Slot } from './crypto'
import { newRecoveryKey, normalizeRecoveryKey, verifyTotp } from './totp'

export type AuthMode = 'password' | 'device'

export interface Vault {
  /** Database encryption key, hex. */
  dbKey: string
  totp?: { secret: string; lastStep: number }
}

export interface AccountData {
  version: 2
  mode: AuthMode
  createdAt: string
  twoFactor: boolean
  slots: {
    password?: Slot
    recovery: Slot
    /** Passwordless only: the master key itself, protected solely by the device seal. */
    device?: string
  }
  vault: Sealed
  attempts: { failed: number; lastFailedAt: string | null }
}

export interface Unlocked {
  master: Buffer
  vault: Vault
}

const VAULT_LABEL = 'kasboek:vault'

export function sealVault(master: Buffer, vault: Vault): Sealed {
  return seal(master, Buffer.from(JSON.stringify(vault), 'utf8'), VAULT_LABEL)
}

export function openVault(master: Buffer, sealed: Sealed): Vault {
  const plain = unseal(master, sealed, VAULT_LABEL)
  if (!plain) throw new AppError('auth.corrupt', 'The account data is damaged.')
  return JSON.parse(plain.toString('utf8')) as Vault
}

export async function createAccount(input: {
  mode: AuthMode
  password?: string
  dbKey: string
}): Promise<{ account: AccountData; master: Buffer; vault: Vault; recoveryKey: string }> {
  const master = random(32)
  const recoveryKey = newRecoveryKey()
  const vault: Vault = { dbKey: input.dbKey }
  if (input.mode === 'password' && !input.password) throw new AppError('auth.password_required', 'Choose a password.')
  const account: AccountData = {
    version: 2,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    twoFactor: false,
    slots: {
      recovery: await makeSlot(master, normalizeRecoveryKey(recoveryKey), 'recovery'),
      ...(input.mode === 'password'
        ? { password: await makeSlot(master, input.password!, 'password') }
        : { device: master.toString('base64') })
    },
    vault: sealVault(master, vault),
    attempts: { failed: 0, lastFailedAt: null }
  }
  return { account, master, vault, recoveryKey }
}

/* ---------- Throttling (app-enforced; the KDF cost is the real barrier) ---------- */

const FREE_ATTEMPTS = 5

/** Seconds to wait before the next attempt is allowed. */
export function throttleSeconds(account: AccountData, now = Date.now()): number {
  const { failed, lastFailedAt } = account.attempts
  if (failed < FREE_ATTEMPTS || !lastFailedAt) return 0
  const delay = Math.min(15 * 60, 30 * 2 ** (failed - FREE_ATTEMPTS))
  return Math.max(0, Math.ceil((Date.parse(lastFailedAt) + delay * 1000 - now) / 1000))
}

function checkThrottle(account: AccountData): void {
  const wait = throttleSeconds(account)
  if (wait > 0) throw new AppError('auth.throttled', `Too many attempts. Try again in ${wait} seconds.`)
}

export function recordFailure(account: AccountData): AccountData {
  return { ...account, attempts: { failed: account.attempts.failed + 1, lastFailedAt: new Date().toISOString() } }
}

function verifySecondFactor(account: AccountData, vault: Vault, code: string | undefined): Vault {
  if (!account.twoFactor) return vault
  if (!vault.totp) throw new AppError('auth.corrupt', 'Two-factor settings are missing.')
  const step = code ? verifyTotp(vault.totp.secret, code, vault.totp.lastStep) : null
  if (step === null) return null as unknown as Vault
  return { ...vault, totp: { ...vault.totp, lastStep: step } }
}

/**
 * Unlocks with the password (and 2FA code if enabled). On failure returns the account with the
 * failure recorded, so the caller can save it. The error never says which factor was wrong.
 */
export async function unlockWithPassword(
  account: AccountData,
  password: string,
  code?: string
): Promise<{ ok: true; unlocked: Unlocked; account: AccountData } | { ok: false; account: AccountData }> {
  checkThrottle(account)
  if (account.mode !== 'password' || !account.slots.password) throw new AppError('auth.wrong_mode', 'This account uses Windows Hello or Touch ID.')
  const master = await openSlot(account.slots.password, password, 'password')
  if (!master) return { ok: false, account: recordFailure(account) }
  const vault = verifySecondFactor(account, openVault(master, account.vault), code)
  if (!vault) return { ok: false, account: recordFailure(account) }
  // Re-make an older scrypt slot with Argon2id now that we know the password.
  const upgraded = slotNeedsUpgrade(account.slots.password) ? { ...account, slots: { ...account.slots, password: await makeSlot(master, password, 'password') } } : account
  return succeed(upgraded, master, vault)
}

/** Passwordless: the caller has already verified the user with Windows Hello / Touch ID. */
export function unlockWithDevice(
  account: AccountData,
  code?: string
): { ok: true; unlocked: Unlocked; account: AccountData } | { ok: false; account: AccountData } {
  checkThrottle(account)
  if (account.mode !== 'device' || !account.slots.device) throw new AppError('auth.wrong_mode', 'This account uses a password.')
  const master = Buffer.from(account.slots.device, 'base64')
  const vault = verifySecondFactor(account, openVault(master, account.vault), code)
  if (!vault) return { ok: false, account: recordFailure(account) }
  return succeed(account, master, vault)
}

/** The recovery key replaces both the password and the 2FA code. */
export async function unlockWithRecovery(
  account: AccountData,
  recoveryKey: string
): Promise<{ ok: true; unlocked: Unlocked; account: AccountData } | { ok: false; account: AccountData }> {
  checkThrottle(account)
  const master = await openSlot(account.slots.recovery, normalizeRecoveryKey(recoveryKey), 'recovery')
  if (!master) return { ok: false, account: recordFailure(account) }
  return succeed(account, master, openVault(master, account.vault))
}

function succeed(account: AccountData, master: Buffer, vault: Vault) {
  return {
    ok: true as const,
    unlocked: { master, vault },
    account: { ...account, vault: sealVault(master, vault), attempts: { failed: 0, lastFailedAt: null } }
  }
}

/* ---------- Changes (all require an unlocked master key) ---------- */

export async function setPassword(account: AccountData, master: Buffer, password: string): Promise<AccountData> {
  const { device: _device, ...rest } = account.slots
  return { ...account, mode: 'password', slots: { ...rest, password: await makeSlot(master, password, 'password') } }
}

export function setPasswordless(account: AccountData, master: Buffer): AccountData {
  const { password: _password, ...rest } = account.slots
  return { ...account, mode: 'device', slots: { ...rest, device: master.toString('base64') } }
}

export async function rotateRecoveryKey(account: AccountData, master: Buffer): Promise<{ account: AccountData; recoveryKey: string }> {
  const recoveryKey = newRecoveryKey()
  return {
    recoveryKey,
    account: { ...account, slots: { ...account.slots, recovery: await makeSlot(master, normalizeRecoveryKey(recoveryKey), 'recovery') } }
  }
}

export function setTwoFactor(account: AccountData, master: Buffer, vault: Vault, totp: Vault['totp'] | null): { account: AccountData; vault: Vault } {
  const next: Vault = { ...vault }
  if (totp) next.totp = totp
  else delete next.totp
  return { vault: next, account: { ...account, twoFactor: !!totp, vault: sealVault(master, next) } }
}

export function storeVault(account: AccountData, master: Buffer, vault: Vault): AccountData {
  return { ...account, vault: sealVault(master, vault) }
}
