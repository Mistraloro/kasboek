/**
 * Reads and writes account.json, sealed by the operating system (DPAPI on Windows,
 * Keychain on macOS, Secret Service on Linux). This seal is what binds the data to this
 * computer and user account: a copied file can't be opened elsewhere, even with the password.
 */
import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import type { AccountData } from '@core/account'
import { AppError } from '@core/errors'
import type { KeyProtection } from '@shared/types'
import { paths } from '../paths'

interface AccountFile {
  format: 'kasboek-account'
  version: 2
  seal: 'os' | 'none'
  data: string
}

let available: boolean | null = null

async function osAvailable(): Promise<boolean> {
  if (available === null) available = await safeStorage.isAsyncEncryptionAvailable()
  return available
}

export async function keyProtection(): Promise<KeyProtection> {
  if (!(await osAvailable())) return 'weak'
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return 'weak'
  return 'os'
}

export function accountExists(): boolean {
  return existsSync(paths.accountFile)
}

export async function loadAccount(): Promise<AccountData | null> {
  if (!existsSync(paths.accountFile)) return null
  const file = JSON.parse(await readFile(paths.accountFile, 'utf8')) as AccountFile
  if (file.format !== 'kasboek-account') throw new AppError('auth.corrupt', 'The account file is damaged.')
  let json: string
  if (file.seal === 'os') {
    try {
      json = (await safeStorage.decryptStringAsync(Buffer.from(file.data, 'base64'))).result
    } catch {
      // Typical when the data folder was copied from another computer or user account.
      throw new AppError(
        'auth.other_device',
        'This Kasboek data belongs to another computer or user account and can’t be opened here. Use Export on the old computer and Import here.'
      )
    }
  } else {
    json = Buffer.from(file.data, 'base64').toString('utf8')
  }
  try {
    return JSON.parse(json) as AccountData
  } catch {
    throw new AppError(
      'auth.other_device',
      'This Kasboek data can’t be opened here. It may come from another computer or user account: use Export on the old computer and Import here.'
    )
  }
}

export async function saveAccount(account: AccountData): Promise<void> {
  const json = JSON.stringify(account)
  const os = await osAvailable()
  const file: AccountFile = {
    format: 'kasboek-account',
    version: 2,
    seal: os ? 'os' : 'none',
    data: os ? (await safeStorage.encryptStringAsync(json)).toString('base64') : Buffer.from(json).toString('base64')
  }
  const tmp = paths.accountFile + '.tmp'
  await writeFile(tmp, JSON.stringify(file), { mode: 0o600 })
  await rename(tmp, paths.accountFile)
}

export async function deleteAccount(): Promise<void> {
  await rm(paths.accountFile, { force: true })
}

/** Phase 1 stored the database key in keystore.json. Returns it so setup can keep the existing data. */
export async function readLegacyDbKey(): Promise<string | null> {
  if (!existsSync(paths.legacyKeystoreFile) || !existsSync(paths.dbFile)) return null
  try {
    const data = JSON.parse(await readFile(paths.legacyKeystoreFile, 'utf8')) as { dbKey?: string }
    const v = data.dbKey ?? ''
    if (v.startsWith('os:')) return (await safeStorage.decryptStringAsync(Buffer.from(v.slice(3), 'base64'))).result
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8')
  } catch {
    // Unreadable: treat as no legacy data.
  }
  return null
}

export async function removeLegacyKeystore(): Promise<void> {
  await rm(paths.legacyKeystoreFile, { force: true })
}
