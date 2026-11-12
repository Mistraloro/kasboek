/**
 * Export (move to another computer), automatic backups and import. All use the same
 * .kasboek format, which opens only through Import with the login credentials.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { AccountData } from '@core/account'
import { makeSlot } from '@core/crypto'
import { integrityOk, openDatabase, snapshotEncrypted } from '@core/database'
import { AppError } from '@core/errors'
import { MIGRATIONS, schemaVersion } from '@core/migrations'
import { getSettings, updateSettings } from '@core/settings'
import { encodeTransfer, openTransfer, readTransferHeader, TRANSFER_EXTENSION } from '@core/transfer-format'
import type { BackupStatus, PickedTransfer } from '@shared/types'
import { paths } from '../paths'
import { deviceAuthKind } from '../security/device-auth'
import { adopt, closeForReplace, db, isUnlocked, secrets } from '../session'

const AUTO_FILE = new RegExp(`^kasboek-backup-[0-9_-]+\\.${TRANSFER_EXTENSION}$`)

export function stamp(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export const exportFileName = (): string => `kasboek-export-${stamp()}.${TRANSFER_EXTENSION}`
const backupFileName = (): string => `kasboek-backup-${stamp()}.${TRANSFER_EXTENSION}`

export function backupStatus(): BackupStatus {
  const s = getSettings(db())
  return { autoEnabled: s.autoBackupEnabled, folder: s.autoBackupFolder, keep: s.autoBackupKeep, lastBackupAt: s.lastBackupAt, lastBackupFile: s.lastBackupFile }
}

/** Writes an export/backup of the live data to `file`. Needs Kasboek to be unlocked. */
export async function writeTransfer(file: string, kind: 'export' | 'backup'): Promise<string> {
  const { account, master, vault } = secrets()
  const live = db()
  const tmp = join(paths.dataDir, `snapshot-${randomUUID()}.tmp`)
  try {
    snapshotEncrypted(live, tmp)
    const bytes = encodeTransfer({ kind, account, master, vault, dbFile: await readFile(tmp), appVersion: app.getVersion(), schemaVersion: schemaVersion(live) })
    const partial = file + '.partial'
    await writeFile(partial, bytes, { mode: 0o600 })
    await rename(partial, file)
  } finally {
    await rm(tmp, { force: true })
  }
  if (kind === 'backup') updateSettings(live, { lastBackupAt: new Date().toISOString(), lastBackupFile: file })
  return file
}

/* ---------- Automatic backups ---------- */

export async function runAutoBackupIfDue(maxAgeHours = 24): Promise<string | null> {
  if (!isUnlocked()) return null
  const s = getSettings(db())
  if (!s.autoBackupEnabled || !s.autoBackupFolder) return null
  // A missing folder may be an unplugged drive or a path from another computer: skip, don't create it.
  if (!existsSync(s.autoBackupFolder)) return null
  const newest = await newestBackupTime(s.autoBackupFolder)
  if (newest && Date.now() - newest < maxAgeHours * 3600_000) return null
  return runAutoBackup()
}

export async function runAutoBackup(): Promise<string> {
  const s = getSettings(db())
  if (!s.autoBackupFolder) throw new AppError('backup.no_folder', 'Choose a backup folder first.')
  if (!existsSync(s.autoBackupFolder)) throw new AppError('backup.folder_missing', 'The backup folder can’t be found. Is the drive connected?')
  const file = await writeTransfer(join(s.autoBackupFolder, backupFileName()), 'backup')
  await prune(s.autoBackupFolder, s.autoBackupKeep)
  return file
}

async function listBackups(folder: string): Promise<{ n: string; t: number }[]> {
  const names = (await readdir(folder)).filter((n) => AUTO_FILE.test(n))
  return Promise.all(names.map(async (n) => ({ n, t: (await stat(join(folder, n))).mtimeMs })))
}

async function newestBackupTime(folder: string): Promise<number | null> {
  const list = await listBackups(folder)
  return list.length ? Math.max(...list.map((x) => x.t)) : null
}

/** Keeps the newest `keep` automatic backups. Only touches files Kasboek named. */
async function prune(folder: string, keep: number): Promise<void> {
  const list = (await listBackups(folder)).sort((a, b) => b.t - a.t)
  for (const { n } of list.slice(keep)) await rm(join(folder, n), { force: true })
}

/* ---------- Import ---------- */

// The renderer never sends a file path; it gets a token for a file the user picked.
const picked = new Map<string, string>()

export async function describeTransfer(file: string): Promise<PickedTransfer> {
  const h = readTransferHeader(await readFile(file))
  const token = randomUUID()
  picked.set(token, file)
  return {
    token,
    fileName: basename(file),
    kind: h.kind,
    createdAt: h.createdAt,
    appVersion: h.appVersion,
    mode: h.mode,
    twoFactor: h.twoFactor,
    hasPassword: !!h.slots.password,
    needsNewPassword: h.mode === 'device' && !(await deviceAuthKind())
  }
}

export async function importTransfer(input: {
  token: string
  password?: string
  code?: string
  recoveryKey?: string
  newPassword?: string
}): Promise<void> {
  const file = picked.get(input.token)
  if (!file) throw new AppError('transfer.expired', 'Choose the file again.')
  const contents = await openTransfer(
    await readFile(file),
    input.recoveryKey ? { recoveryKey: input.recoveryKey } : { password: input.password ?? '', code: input.code }
  )
  const { header, master, vault, dbFile, usedRecovery } = contents
  if (header.schemaVersion > MIGRATIONS.length) {
    throw new AppError('transfer.too_new', 'This file was made by a newer version of Kasboek. Update the app first.')
  }

  // Check the database inside before touching anything.
  const staged = join(paths.dataDir, `import-${randomUUID()}.db`)
  await writeFile(staged, dbFile, { mode: 0o600 })
  try {
    const check = openDatabase(staged, vault.dbKey, { migrate: false })
    const ok = integrityOk(check)
    check.close()
    if (!ok) throw new AppError('transfer.corrupt', 'The data inside this file is damaged.')
  } catch (err) {
    await rm(staged, { force: true })
    throw err
  }

  // Build the account for this computer. The device seal is added when it's saved.
  let next: AccountData = {
    version: 2,
    mode: header.mode,
    createdAt: new Date().toISOString(),
    twoFactor: header.twoFactor,
    slots: { recovery: header.slots.recovery, ...(header.slots.password ? { password: header.slots.password } : {}) },
    vault: { iv: '', ct: '' },
    attempts: { failed: 0, lastFailedAt: null }
  }
  if (header.mode === 'device') {
    if (await deviceAuthKind()) {
      next.slots.device = master.toString('base64')
    } else {
      if (!input.newPassword) {
        await rm(staged, { force: true })
        throw new AppError('transfer.needs_new_password', 'Windows Hello and Touch ID aren’t available here. Choose a password for this computer.')
      }
      next = { ...next, mode: 'password', slots: { ...next.slots, password: await makeSlot(master, input.newPassword, 'password') } }
    }
  }

  // Replacing data on this computer: keep a safety copy of what's here first.
  if (isUnlocked()) {
    mkdirSync(paths.safetyDir, { recursive: true })
    await writeTransfer(join(paths.safetyDir, `before-import-${stamp()}.${TRANSFER_EXTENSION}`), 'backup')
  }
  closeForReplace()
  await rename(staged, paths.dbFile)
  await adopt(next, master, vault, usedRecovery)
  picked.delete(input.token)
}
