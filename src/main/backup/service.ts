import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { integrityOk, openDatabase, snapshotEncrypted } from '@core/database'
import { AppError } from '@core/errors'
import { MIGRATIONS, schemaVersion } from '@core/migrations'
import { getSettings, updateSettings } from '@core/settings'
import {
  BACKUP_EXTENSION,
  backupFileName,
  decodeBackup,
  encodeBackup,
  readBackupHeader
} from '@core/backup-format'
import type { BackupStatus, PickedBackup } from '@shared/types'
import { db, keystore, paths } from '../state'

const BACKUP_FILE = new RegExp(`^kasboek-[0-9_-]+\\.${BACKUP_EXTENSION}$`)

export function backupStatus(): BackupStatus {
  const s = getSettings(db())
  return {
    passwordSet: keystore().backupPassword !== null,
    autoEnabled: s.autoBackupEnabled,
    folder: s.autoBackupFolder,
    keep: s.autoBackupKeep,
    lastBackupAt: s.lastBackupAt,
    lastBackupFile: s.lastBackupFile
  }
}

function requirePassword(): string {
  const password = keystore().backupPassword
  if (!password) throw new AppError('backup.no_password', 'Set a backup password first.')
  return password
}

/** Writes an encrypted backup of the live database to `file`. */
export async function writeBackup(file: string): Promise<string> {
  const password = requirePassword()
  const live = db()
  const tmp = join(paths.dataDir, `snapshot-${randomUUID()}.tmp`)
  try {
    snapshotEncrypted(live, tmp)
    const bytes = await encodeBackup({
      password,
      dbKeyHex: keystore().dbKey,
      dbFile: await readFile(tmp),
      appVersion: app.getVersion(),
      schemaVersion: schemaVersion(live)
    })
    // Write next to the target, then rename, so a crash never leaves half a backup.
    const partial = file + '.partial'
    await writeFile(partial, bytes, { mode: 0o600 })
    await rename(partial, file)
  } finally {
    await rm(tmp, { force: true })
  }
  updateSettings(live, { lastBackupAt: new Date().toISOString(), lastBackupFile: file })
  return file
}

/** Runs the automatic backup if it is switched on and due. Returns the file, or null if skipped. */
export async function runAutoBackupIfDue(maxAgeHours = 24): Promise<string | null> {
  const s = getSettings(db())
  if (!s.autoBackupEnabled || !s.autoBackupFolder || !keystore().backupPassword) return null
  // A missing folder may be an unplugged drive or a path from another computer: skip, don't create it.
  if (!existsSync(s.autoBackupFolder)) return null
  const newest = await newestBackupTime(s.autoBackupFolder)
  if (newest && Date.now() - newest < maxAgeHours * 3600_000) return null
  return runAutoBackup()
}

export async function runAutoBackup(): Promise<string> {
  const s = getSettings(db())
  if (!s.autoBackupFolder) throw new AppError('backup.no_folder', 'Choose a backup folder first.')
  if (!existsSync(s.autoBackupFolder)) {
    throw new AppError('backup.folder_missing', 'The backup folder can’t be found. Is the drive connected?')
  }
  const file = await writeBackup(join(s.autoBackupFolder, backupFileName()))
  await prune(s.autoBackupFolder, s.autoBackupKeep)
  return file
}

/** Modification time of the newest Kasboek backup in `folder`, or null. */
async function newestBackupTime(folder: string): Promise<number | null> {
  const names = (await readdir(folder)).filter((n) => BACKUP_FILE.test(n))
  const times = await Promise.all(names.map(async (n) => (await stat(join(folder, n))).mtimeMs))
  return times.length ? Math.max(...times) : null
}

/** Keeps the newest `keep` automatic backups in `folder`. Only touches files Kasboek named. */
async function prune(folder: string, keep: number): Promise<void> {
  const names = (await readdir(folder)).filter((n) => BACKUP_FILE.test(n))
  const withTime = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(join(folder, n))).mtimeMs }))
  )
  withTime.sort((a, b) => b.t - a.t)
  for (const { n } of withTime.slice(keep)) await rm(join(folder, n), { force: true })
}

/* ---------- Restore ---------- */

// The renderer never sends a file path; it gets a token for a file the user picked.
const picked = new Map<string, string>()

export async function describeBackup(file: string): Promise<PickedBackup> {
  const header = readBackupHeader(await readFile(file))
  const token = randomUUID()
  picked.set(token, file)
  return { token, fileName: basename(file), createdAt: header.createdAt, appVersion: header.appVersion }
}

/**
 * Checks the backup, swaps it in and returns. The caller must relaunch the app.
 * The current database is first saved as a safety backup (if a password is set).
 */
export async function restoreBackup(token: string, password: string, closeLive: () => void): Promise<void> {
  const file = picked.get(token)
  if (!file) throw new AppError('backup.expired', 'Pick the backup file again.')
  const contents = await decodeBackup(await readFile(file), password)
  if (contents.header.schemaVersion > MIGRATIONS.length) {
    throw new AppError('backup.too_new', 'This backup was made by a newer version of Kasboek. Update the app first.')
  }

  // Verify the database inside the backup before touching anything.
  const staged = join(paths.dataDir, `restore-${randomUUID()}.db`)
  await writeFile(staged, contents.dbFile, { mode: 0o600 })
  try {
    const check = openDatabase(staged, contents.dbKeyHex, { migrate: false })
    const ok = integrityOk(check)
    check.close()
    if (!ok) throw new AppError('backup.corrupt', 'The database inside this backup is damaged.')
  } catch (err) {
    await rm(staged, { force: true })
    throw err
  }

  if (keystore().backupPassword) {
    if (!existsSync(paths.safetyDir)) mkdirSync(paths.safetyDir, { recursive: true })
    await writeBackup(join(paths.safetyDir, 'before-restore-' + backupFileName()))
  }

  closeLive()
  await rename(staged, paths.dbFile)
  await keystore().setDbKey(contents.dbKeyHex)
  // Keep using the password that opened this backup for future backups.
  await keystore().setBackupPassword(password)
  picked.delete(token)
}
