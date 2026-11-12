/**
 * Stores the database key (and optionally the backup password) protected by the
 * operating system: DPAPI on Windows, Keychain on macOS, the Secret Service
 * (GNOME Keyring / KWallet) on Linux. The file is useless on another computer
 * or user account.
 *
 * Secrets are decrypted once at start-up and held in memory while the app runs.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { safeStorage } from 'electron'
import type { KeyProtection } from '@shared/types'

interface KeystoreFile {
  version: 1
  /** `os:` = encrypted by the operating system, `plain:` = no OS protection available. */
  dbKey: string
  backupPassword?: string
}

export class Keystore {
  private dbKeyHex = ''
  private backupPw: string | null = null
  private available = false
  /** True if no keystore existed and a new database key was generated. */
  created = false

  private constructor(private readonly file: string) {}

  static async load(file: string): Promise<Keystore> {
    const ks = new Keystore(file)
    ks.available = await safeStorage.isAsyncEncryptionAvailable()
    if (!existsSync(file)) {
      ks.created = true
      ks.dbKeyHex = randomBytes(32).toString('hex')
      await ks.save()
      return ks
    }
    const data = JSON.parse(await readFile(file, 'utf8')) as KeystoreFile
    let rewrap = false
    const open = async (value: string): Promise<string> => {
      const r = await ks.unwrap(value)
      rewrap ||= r.rewrap
      return r.secret
    }
    ks.dbKeyHex = await open(data.dbKey)
    ks.backupPw = data.backupPassword ? await open(data.backupPassword) : null
    // Re-protect if the OS rotated its key, or if protection became available since last time.
    if (rewrap) await ks.save()
    return ks
  }

  protection(): KeyProtection {
    if (!this.available) return 'weak'
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return 'weak'
    return 'os'
  }

  get dbKey(): string {
    return this.dbKeyHex
  }

  get backupPassword(): string | null {
    return this.backupPw
  }

  async setDbKey(keyHex: string): Promise<void> {
    this.dbKeyHex = keyHex
    await this.save()
  }

  async setBackupPassword(password: string): Promise<void> {
    this.backupPw = password
    await this.save()
  }

  private async wrap(secret: string): Promise<string> {
    if (this.available) return 'os:' + (await safeStorage.encryptStringAsync(secret)).toString('base64')
    return 'plain:' + Buffer.from(secret, 'utf8').toString('base64')
  }

  private async unwrap(value: string): Promise<{ secret: string; rewrap: boolean }> {
    if (value.startsWith('os:')) {
      const r = await safeStorage.decryptStringAsync(Buffer.from(value.slice(3), 'base64'))
      return { secret: r.result, rewrap: r.shouldReEncrypt }
    }
    if (value.startsWith('plain:')) {
      return { secret: Buffer.from(value.slice(6), 'base64').toString('utf8'), rewrap: this.available }
    }
    throw new Error('Unknown keystore entry format')
  }

  private async save(): Promise<void> {
    const data: KeystoreFile = { version: 1, dbKey: await this.wrap(this.dbKeyHex) }
    if (this.backupPw) data.backupPassword = await this.wrap(this.backupPw)
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
