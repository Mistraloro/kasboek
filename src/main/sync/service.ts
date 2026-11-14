/**
 * Sync through a folder the person chooses (Google Drive, OneDrive, Dropbox, iCloud Drive, a
 * network share). Kasboek has no server; the cloud only ever sees encrypted files:
 *
 *   <folder>/Kasboek sync/group.json                 which sync group this is (no secrets)
 *   <folder>/Kasboek sync/<device>/c-<seq>.kbsync     one computer's changes, in order
 *   <folder>/Kasboek sync/<device>/state.kbsync       that computer's name, last seen, progress
 *   <folder>/Kasboek sync/<device>/snapshot.kasboek   its latest full copy, to join from
 *
 * Change and state files are AES-256-GCM encrypted with a random sync key that lives inside the
 * encrypted database (so it reaches a new computer only through a snapshot, which opens only
 * with the password and 2FA code or the recovery key). The file header is authenticated too, so
 * a file can't be moved to another computer's place or renumbered.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { dialog } from 'electron'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret, setSecret } from '@core/secrets'
import * as sync from '@core/sync'
import type { PickedTransfer, SyncStatus } from '@shared/types'
import { paths } from '../paths'
import { broadcast, db as liveDb, isUnlocked, onLock } from '../session'
import { describeTransfer, writeTransfer } from '../transfer/service'

const DIR = 'Kasboek sync'
const MAGIC = Buffer.from('KBSYNC1\n')
const SNAPSHOT_EVERY_MS = 24 * 3600_000
const ACTIVE_DAYS = 90

interface Local {
  deviceId: string
  folder: string | null
}

interface DeviceState {
  deviceId: string
  label: string
  lastSeen: string
  seq: number
  applied: Record<string, number>
  /** What the latest snapshot of this device includes; files it needs must be kept. */
  snapshotApplied: Record<string, number>
  snapshotAt: string | null
  /** This device's files up to here were removed after everyone had them. */
  floor: number
}

/* ---------- This computer ---------- */

function readLocal(): Local {
  try {
    const l = JSON.parse(readFileSync(paths.syncFile, 'utf8')) as Partial<Local>
    if (typeof l.deviceId === 'string' && /^[a-z0-9]{8,40}$/.test(l.deviceId)) return { deviceId: l.deviceId, folder: typeof l.folder === 'string' ? l.folder : null }
  } catch {
    // First use.
  }
  return { deviceId: newDeviceId(), folder: null }
}

function writeLocal(l: Local): void {
  writeFileSync(paths.syncFile + '.tmp', JSON.stringify(l, null, 2))
  renameSync(paths.syncFile + '.tmp', paths.syncFile)
}

const newDeviceId = (): string => randomBytes(8).toString('hex')

/* ---------- Files ---------- */

const groupDir = (folder: string): string => join(folder, DIR)

function readGroup(folder: string): { groupId: string } | null {
  try {
    const g = JSON.parse(readFileSync(join(groupDir(folder), 'group.json'), 'utf8')) as { format?: number; groupId?: string }
    return g.format === 1 && typeof g.groupId === 'string' ? { groupId: g.groupId } : null
  } catch {
    return null
  }
}

function syncKey(db: Db): Buffer {
  const hex = getSecret(db, 'syncKey')
  if (!hex) throw new AppError('sync.no_key', 'The sync key is missing from this data. Stop syncing and start again.')
  return Buffer.from(hex, 'hex')
}

function seal(key: Buffer, header: Record<string, unknown>, payload: unknown): Buffer {
  const h = Buffer.from(JSON.stringify(header))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.concat([MAGIC, h]))
  const ct = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(payload)))), cipher.final()])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(h.length)
  return Buffer.concat([MAGIC, len, h, iv, cipher.getAuthTag(), ct])
}

function open<T>(key: Buffer, file: Buffer, expect: Record<string, unknown>): T {
  if (file.length < MAGIC.length + 4 + 28 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sync file')
  const hl = file.readUInt32BE(MAGIC.length)
  const hStart = MAGIC.length + 4
  const h = file.subarray(hStart, hStart + hl)
  const header = JSON.parse(h.toString('utf8')) as Record<string, unknown>
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) throw new Error(`header ${k} mismatch`)
  const iv = file.subarray(hStart + hl, hStart + hl + 12)
  const tag = file.subarray(hStart + hl + 12, hStart + hl + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.concat([MAGIC, h]))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(file.subarray(hStart + hl + 28)), decipher.final()])
  return JSON.parse(inflateRawSync(plain, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')) as T
}

/** Writes next to the target and renames, so other computers never see half a file. */
function atomicWrite(file: string, data: Buffer): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.partial`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
}

const changeFile = (folder: string, device: string, seq: number): string => join(groupDir(folder), device, `c-${String(seq).padStart(10, '0')}.kbsync`)

function listSeqs(folder: string, device: string): number[] {
  try {
    return readdirSync(join(groupDir(folder), device))
      .map((n) => /^c-(\d{10})\.kbsync$/.exec(n)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

function listDevices(folder: string): string[] {
  try {
    return readdirSync(groupDir(folder), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z0-9]{8,40}$/.test(d.name))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function readState(key: Buffer, groupId: string, folder: string, device: string): DeviceState | null {
  try {
    return open<DeviceState>(key, readFileSync(join(groupDir(folder), device, 'state.kbsync')), { kind: 'state', groupId, device })
  } catch {
    return null
  }
}

/* ---------- Status ---------- */

let busy = false
let lastSyncAt: string | null = null
let lastError: string | null = null

export function syncStatus(): SyncStatus {
  const base: SyncStatus = { state: 'off', folder: null, devices: [], lastSyncAt, error: lastError, conflicts: [], busy }
  if (!isUnlocked()) return base
  const db = liveDb()
  const groupId = sync.getMeta(db, 'groupId')
  if (!sync.isEnabled(db) || !groupId) return base
  const local = readLocal()
  const attached = !!local.folder && readGroup(local.folder)?.groupId === groupId
  const me = sync.getMeta(db, 'deviceId')
  const devices: SyncStatus['devices'] = []
  if (attached) {
    const key = syncKey(db)
    for (const d of listDevices(local.folder!)) {
      const st = readState(key, groupId, local.folder!, d)
      if (st) devices.push({ id: d, label: st.label, lastSeen: st.lastSeen, thisComputer: d === me })
    }
    devices.sort((a, b) => Number(b.thisComputer) - Number(a.thisComputer) || (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
  }
  return { ...base, state: attached ? 'on' : 'detached', folder: local.folder, devices, conflicts: sync.listConflicts(db) }
}

function publish(): void {
  try {
    broadcast({ type: 'sync.updated', status: syncStatus() })
  } catch {
    // Locked meanwhile.
  }
}

/* ---------- Identity ---------- */

/**
 * Makes sure this database speaks for this computer under an id nobody else uses. A database
 * that came from elsewhere (joining, an import, a restored backup) gets a fresh id; what it
 * already contains from its old id is remembered as applied.
 */
function ensureIdentity(db: Db, folder: string): string {
  const local = readLocal()
  const dbDevice = sync.getMeta(db, 'deviceId')
  const dbSeq = Number(sync.getMeta(db, 'seq') ?? '0')
  const foreign = !dbDevice || dbDevice !== local.deviceId
  const behind = !!dbDevice && (listSeqs(folder, dbDevice).at(-1) ?? 0) > dbSeq
  if (!foreign && !behind) return dbDevice
  const id = newDeviceId()
  db.transaction(() => {
    if (dbDevice) sync.setCursor(db, dbDevice, dbSeq)
    sync.setMeta(db, 'deviceId', id)
    sync.setMeta(db, 'seq', '0')
    sync.setMeta(db, 'snapshotAt', null)
    sync.setMeta(db, 'snapshotApplied', null)
  })()
  writeLocal({ deviceId: id, folder })
  return id
}

/* ---------- Starting, joining, stopping ---------- */

async function chooseFolder(title: string): Promise<string | null> {
  const res = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

/** The chosen folder, or the "Kasboek sync" folder inside it, whichever holds a sync group. */
function normalize(folder: string): string {
  if (!readGroup(folder) && folder.endsWith(DIR) && readGroup(join(folder, '..'))) return join(folder, '..')
  return folder
}

export async function startSync(): Promise<SyncStatus> {
  const db = liveDb()
  if (sync.isEnabled(db) && sync.getMeta(db, 'groupId')) throw new AppError('sync.already', 'This computer already syncs.')
  const picked = await chooseFolder('Choose a folder to sync through')
  if (!picked) return syncStatus()
  const folder = normalize(picked)
  if (readGroup(folder)) throw new AppError('sync.exists', 'This folder already holds Kasboek sync data. Use “Join” to sync with it.')
  const groupId = randomBytes(16).toString('hex')
  const deviceId = newDeviceId()
  mkdirSync(join(groupDir(folder), deviceId), { recursive: true })
  writeFileSync(join(groupDir(folder), 'group.json'), JSON.stringify({ format: 1, groupId, createdAt: new Date().toISOString() }, null, 2))
  db.transaction(() => {
    setSecret(db, 'syncKey', randomBytes(32).toString('hex'))
    sync.setMeta(db, 'groupId', groupId)
    sync.setMeta(db, 'deviceId', deviceId)
    sync.setMeta(db, 'seq', '0')
    sync.setMeta(db, 'cursors', '{}')
    sync.enable(db, deviceId)
  })()
  writeLocal({ deviceId, folder })
  await runSync({ forceSnapshot: true })
  return syncStatus()
}

/** Joining: the folder waits here until the snapshot has been imported. */
const pendingJoins = new Map<string, string>()

export async function pickJoin(): Promise<PickedTransfer> {
  const picked = await chooseFolder('Choose the sync folder to join')
  if (!picked) throw new AppError('sync.cancelled', 'No folder chosen.')
  const folder = normalize(picked)
  if (!readGroup(folder)) throw new AppError('sync.not_group', 'This folder holds no Kasboek sync data. Choose the folder you sync through on the other computer.')
  // The newest snapshot of any computer in the group.
  let best: { file: string; time: number } | null = null
  for (const d of listDevices(folder)) {
    const file = join(groupDir(folder), d, 'snapshot.kasboek')
    if (!existsSync(file)) continue
    const time = statSync(file).mtimeMs
    if (!best || time > best.time) best = { file, time }
  }
  if (!best) throw new AppError('sync.no_snapshot', 'No computer has finished its first sync to this folder yet. Wait for it to sync, then try again.')
  const info = await describeTransfer(best.file)
  pendingJoins.set(info.token, folder)
  return info
}

/** After an import: when it was a join, start syncing from that folder on this computer. */
export async function afterImport(token: string): Promise<void> {
  const folder = pendingJoins.get(token)
  pendingJoins.delete(token)
  if (!folder || !isUnlocked()) return
  attachFolder(liveDb(), folder)
  await runSync({ forceSnapshot: true })
}

function attachFolder(db: Db, folder: string): void {
  const groupId = sync.getMeta(db, 'groupId')
  if (!groupId || !sync.isEnabled(db)) throw new AppError('sync.off', 'This data doesn’t sync.')
  if (readGroup(folder)?.groupId !== groupId) throw new AppError('sync.other_group', 'This folder belongs to a different Kasboek sync. Choose the folder this data syncs through.')
  const local = readLocal()
  writeLocal({ ...local, folder })
  ensureIdentity(db, folder)
  lastError = null
}

export async function attach(): Promise<SyncStatus> {
  const picked = await chooseFolder('Choose the sync folder on this computer')
  if (!picked) return syncStatus()
  attachFolder(liveDb(), normalize(picked))
  await runSync({ forceSnapshot: true })
  return syncStatus()
}

/** Stops syncing on this computer. The folder and the other computers are left as they are. */
export function stopSync(): SyncStatus {
  const db = liveDb()
  db.transaction(() => {
    sync.disable(db)
    for (const k of ['groupId', 'deviceId', 'seq', 'cursors', 'snapshotAt', 'clock']) sync.setMeta(db, k, null)
    db.prepare('DELETE FROM sync_rows').run()
    db.prepare('DELETE FROM sync_pending').run()
    setSecret(db, 'syncKey', null)
  })()
  rmSync(paths.syncFile, { force: true })
  lastError = null
  publish()
  return syncStatus()
}

export function dismissConflicts(): SyncStatus {
  sync.dismissConflicts(liveDb())
  publish()
  return syncStatus()
}

/* ---------- The sync cycle ---------- */

/** Writes this computer's pending changes as the next numbered file. Synchronous, so it can run right before locking. */
function pushChanges(db: Db, key: Buffer, groupId: string, folder: string, me: string): number {
  let count = 0
  // The file is written inside the transaction: if writing fails, the changes stay pending.
  db.transaction(() => {
    const changes = sync.flush(db, me)
    if (!changes.length) return
    const seq = Number(sync.getMeta(db, 'seq') ?? '0') + 1
    mkdirSync(join(groupDir(folder), me), { recursive: true })
    atomicWrite(changeFile(folder, me, seq), seal(key, { kind: 'changes', groupId, device: me, seq }, changes))
    sync.setMeta(db, 'seq', String(seq))
    count = changes.length
  })()
  return count
}

interface Attached {
  db: Db
  key: Buffer
  groupId: string
  folder: string
  me: string
}

function attached(): Attached | null {
  if (!isUnlocked()) return null
  const db = liveDb()
  const groupId = sync.getMeta(db, 'groupId')
  if (!sync.isEnabled(db) || !groupId) return null
  const local = readLocal()
  if (!local.folder || readGroup(local.folder)?.groupId !== groupId) return null
  const me = ensureIdentity(db, local.folder)
  return { db, key: syncKey(db), groupId, folder: local.folder, me }
}

let onApplied: (() => void) | null = null
export function onRemoteChanges(fn: () => void): void {
  onApplied = fn
}

export async function runSync(opts: { forceSnapshot?: boolean } = {}): Promise<void> {
  if (busy) return
  const ctx = attached()
  if (!ctx) return
  busy = true
  publish()
  const { db, key, groupId, folder, me } = ctx
  const problems: string[] = []
  let received = 0
  let snapshotted = false
  try {
    mkdirSync(join(groupDir(folder), me), { recursive: true })
    const pushed = pushChanges(db, key, groupId, folder, me)

    // Other computers' files, strictly in order per computer.
    const states = new Map<string, DeviceState>()
    for (const device of listDevices(folder)) {
      if (device === me) continue
      const st = readState(key, groupId, folder, device)
      if (st) states.set(device, st)
      const from = sync.cursors(db)[device] ?? 0
      const seqs = listSeqs(folder, device).filter((s) => s > from)
      let next = from + 1
      for (const seq of seqs) {
        if (seq !== next) {
          // A missing file: still on its way, or removed long ago because this computer was away.
          if (st && st.floor >= next) problems.push(`This computer was away too long to catch up with ${st.label}. Stop syncing here and join again.`)
          break
        }
        let changes: sync.Change[]
        try {
          changes = open<sync.Change[]>(key, readFileSync(changeFile(folder, device, seq)), { kind: 'changes', groupId, device, seq })
        } catch {
          // Probably still being downloaded by the cloud app; try again next time.
          break
        }
        db.transaction(() => {
          const r = sync.apply(db, me, device, changes)
          received += r.applied
          sync.setCursor(db, device, seq)
        })()
        next = seq + 1
      }
    }

    // A fresh snapshot now and then, for computers that join later.
    const seq = Number(sync.getMeta(db, 'seq') ?? '0')
    const snapAt = sync.getMeta(db, 'snapshotAt')
    let snapshotApplied: Record<string, number> | null = null
    if (opts.forceSnapshot || !snapAt || Date.now() - Date.parse(snapAt) > SNAPSHOT_EVERY_MS) {
      await writeTransfer(join(groupDir(folder), me, 'snapshot.kasboek'), 'export')
      sync.setMeta(db, 'snapshotAt', new Date().toISOString())
      sync.setMeta(db, 'snapshotApplied', JSON.stringify({ ...sync.cursors(db), [me]: seq }))
      snapshotted = true
    }
    snapshotApplied = JSON.parse(sync.getMeta(db, 'snapshotApplied') ?? '{}') as Record<string, number>

    // Remove own change files every active computer and every snapshot already has.
    const prevState = readState(key, groupId, folder, me)
    let floor = prevState?.floor ?? 0
    const cutoff = Date.now() - ACTIVE_DAYS * 86400_000
    const active = [...states.values()].filter((s) => Date.parse(s.lastSeen) > cutoff)
    const safe = Math.min(seq, snapshotApplied[me] ?? 0, ...active.map((s) => Math.min(s.applied[me] ?? 0, s.snapshotApplied[me] ?? 0)))
    for (const s of listSeqs(folder, me)) {
      if (s > safe) break
      rmSync(changeFile(folder, me, s), { force: true })
      floor = Math.max(floor, s)
    }

    // The state file only changes when there is news, or hourly to show this computer is still around.
    const stale = !prevState || Date.now() - Date.parse(prevState.lastSeen) > 3600_000
    if (!pushed && !received && !snapshotted && !stale && floor === prevState?.floor && JSON.stringify(prevState?.applied) === JSON.stringify(sync.cursors(db))) {
      lastSyncAt = new Date().toISOString()
      lastError = problems[0] ?? null
      return
    }

    const state: DeviceState = {
      deviceId: me,
      label: hostname() || 'Computer',
      lastSeen: new Date().toISOString(),
      seq,
      applied: sync.cursors(db),
      snapshotApplied,
      snapshotAt: sync.getMeta(db, 'snapshotAt'),
      floor
    }
    atomicWrite(join(groupDir(folder), me, 'state.kbsync'), seal(key, { kind: 'state', groupId, device: me }, state))
    lastSyncAt = state.lastSeen
    lastError = problems[0] ?? null
  } catch (err) {
    lastError = err instanceof AppError ? err.message : `Sync failed: ${err instanceof Error ? err.message : String(err)}. Kasboek will try again.`
  } finally {
    busy = false
    publish()
    if (received) onApplied?.()
  }
}

/* ---------- When ---------- */

let soon: NodeJS.Timeout | null = null

/** After a local change: sync a few seconds later (changes in a row go out together). */
export function changedLocally(): void {
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => {
    soon = null
    void runSync()
  }, 8_000)
}

export function startSyncScheduler(): void {
  setInterval(() => void runSync(), 60_000)
  // Right before the database closes: write out what changed, so other computers get it.
  onLock(() => {
    try {
      const ctx = attached()
      if (ctx) pushChanges(ctx.db, ctx.key, ctx.groupId, ctx.folder, ctx.me)
    } catch (err) {
      console.error('[sync] before lock failed', err)
    }
  })
}
