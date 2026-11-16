/**
 * Sync between computers through a store the person chooses: a folder a cloud app keeps in step
 * (OneDrive, Google Drive, Dropbox, iCloud Drive, a network share) or a WebDAV server (Nextcloud,
 * ownCloud, Synology, a NAS, …). Kasboek has no server; the store only ever sees encrypted files:
 *
 *   Kasboek sync/group.json                 which sync group this is (no secrets)
 *   Kasboek sync/<device>/c-<seq>.kbsync     one computer's changes, in order
 *   Kasboek sync/<device>/state.kbsync       that computer's name, last seen, progress
 *   Kasboek sync/<device>/snapshot.kasboek   its latest full copy, to join from
 *
 * Change and state files are AES-256-GCM encrypted with a random sync key that lives inside the
 * encrypted database (so it reaches a new computer only through a snapshot, which opens only
 * with the password and 2FA code or the recovery key). The file header is authenticated too, so
 * a file can't be moved to another computer's place or renumbered.
 *
 * New change files are written to a local outbox first (synchronously, inside the database
 * transaction, so nothing is lost when Kasboek locks), and uploaded to the store after that.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { dialog } from 'electron'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret, setSecret } from '@core/secrets'
import * as sync from '@core/sync'
import { openSyncFile as open, sealSyncFile as seal } from '@core/sync-file'
import { SYNC_DIR, WebDavStore, normalizeWebDavUrl, type SyncStore } from '@core/sync-store'
import { FolderStore } from '@core/sync-store-folder'
import type { PickedTransfer, SyncStatus } from '@shared/types'
import { paths } from '../paths'
import { broadcast, db as liveDb, isUnlocked, onLock } from '../session'
import { describeTransfer, writeTransfer } from '../transfer/service'

const SNAPSHOT_EVERY_MS = 24 * 3600_000
const ACTIVE_DAYS = 90

/** Where this computer syncs: a folder, or a WebDAV server (its password is in the encrypted database). */
type Place = { kind: 'folder'; folder: string } | { kind: 'webdav'; url: string; user: string }

interface Local {
  deviceId: string
  /** The folder, for a folder store (kept under this name for files written by 0.13 and earlier). */
  folder: string | null
  webdav?: { url: string; user: string } | null
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

/** What the person enters for a WebDAV server. */
export interface WebDavInput {
  url: string
  user: string
  password: string
}

/* ---------- This computer ---------- */

function readLocal(): Local {
  try {
    const l = JSON.parse(readFileSync(paths.syncFile, 'utf8')) as Partial<Local>
    if (typeof l.deviceId === 'string' && /^[a-z0-9]{8,40}$/.test(l.deviceId)) {
      const webdav = l.webdav && typeof l.webdav.url === 'string' && typeof l.webdav.user === 'string' ? { url: l.webdav.url, user: l.webdav.user } : null
      return { deviceId: l.deviceId, folder: typeof l.folder === 'string' ? l.folder : null, webdav }
    }
  } catch {
    // First use.
  }
  return { deviceId: newDeviceId(), folder: null, webdav: null }
}

function writeLocal(l: Local): void {
  writeFileSync(paths.syncFile + '.tmp', JSON.stringify(l, null, 2))
  renameSync(paths.syncFile + '.tmp', paths.syncFile)
}

const placeOf = (l: Local): Place | null => (l.webdav ? { kind: 'webdav', ...l.webdav } : l.folder ? { kind: 'folder', folder: l.folder } : null)
const placeLabel = (p: Place): string => (p.kind === 'folder' ? p.folder : p.url)

function setPlace(place: Place | null, deviceId?: string): void {
  const l = readLocal()
  writeLocal({
    deviceId: deviceId ?? l.deviceId,
    folder: place?.kind === 'folder' ? place.folder : null,
    webdav: place?.kind === 'webdav' ? { url: place.url, user: place.user } : null
  })
}

const newDeviceId = (): string => randomBytes(8).toString('hex')

/* ---------- Stores ---------- */

/** The store for this computer's place; a WebDAV store needs its password from the unlocked database. */
function storeFor(place: Place, db: Db): SyncStore {
  if (place.kind === 'folder') return new FolderStore(place.folder)
  const password = getSecret(db, 'webdavPassword')
  if (password === null) throw new AppError('webdav.no_password', 'The WebDAV password is missing on this computer. Choose the server again.')
  return new WebDavStore({ url: place.url, user: place.user, password })
}

const isStoreError = (err: unknown): boolean => err instanceof AppError && err.code.startsWith('webdav.')
const dec = new TextDecoder()

async function readGroup(store: SyncStore): Promise<{ groupId: string } | null> {
  try {
    const raw = await store.read('group.json')
    if (!raw) return null
    const g = JSON.parse(dec.decode(raw)) as { format?: number; groupId?: string }
    return g.format === 1 && typeof g.groupId === 'string' ? { groupId: g.groupId } : null
  } catch (err) {
    // A server that can't be reached or refuses the login: say so instead of "no sync data here".
    if (isStoreError(err)) throw err
    return null
  }
}

function syncKey(db: Db): Buffer {
  const hex = getSecret(db, 'syncKey')
  if (!hex) throw new AppError('sync.no_key', 'The sync key is missing from this data. Stop syncing and start again.')
  return Buffer.from(hex, 'hex')
}

const changeName = (seq: number): string => `c-${String(seq).padStart(10, '0')}.kbsync`
const changePath = (device: string, seq: number): string => `${device}/${changeName(seq)}`
const seqsOf = (names: string[]): number[] =>
  names
    .map((n) => /^c-(\d{10})\.kbsync$/.exec(n)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b)

async function listSeqs(store: SyncStore, device: string): Promise<number[]> {
  return seqsOf((await store.list(device)).map((e) => e.name))
}

async function listDevices(store: SyncStore): Promise<string[]> {
  return (await store.list('')).filter((e) => e.dir && /^[a-z0-9]{8,40}$/.test(e.name)).map((e) => e.name)
}

async function readState(store: SyncStore, key: Buffer, groupId: string, device: string): Promise<DeviceState | null> {
  try {
    const raw = await store.read(`${device}/state.kbsync`)
    return raw ? open<DeviceState>(key, Buffer.from(raw), { kind: 'state', groupId, device }) : null
  } catch (err) {
    if (isStoreError(err)) throw err
    return null
  }
}

/* ---------- Outbox: change files not yet in the store ---------- */

const outboxDir = (): string => join(paths.dataDir, 'sync-outbox')

function outboxSeqs(): number[] {
  try {
    return seqsOf(readdirSync(outboxDir()))
  } catch {
    return []
  }
}

function writeOutbox(seq: number, data: Buffer): void {
  mkdirSync(outboxDir(), { recursive: true })
  const file = join(outboxDir(), changeName(seq))
  writeFileSync(file + '.partial', data, { mode: 0o600 })
  renameSync(file + '.partial', file)
}

/** Uploads waiting change files in order; stops at the first failure (the rest goes next time). */
async function flushOutbox(store: SyncStore, me: string): Promise<void> {
  for (const seq of outboxSeqs()) {
    const file = join(outboxDir(), changeName(seq))
    await store.write(changePath(me, seq), readFileSync(file))
    rmSync(file, { force: true })
  }
}

/* ---------- Status ---------- */

let busy = false
let lastSyncAt: string | null = null
let lastError: string | null = null
/** From the last sync: the computers in the group (reading the store for every status would be slow over WebDAV). */
let known: { groupId: string; place: string; devices: SyncStatus['devices'] } | null = null

export function syncStatus(): SyncStatus {
  const base: SyncStatus = { state: 'off', folder: null, kind: null, devices: [], lastSyncAt, error: lastError, conflicts: [], busy }
  if (!isUnlocked()) return base
  const db = liveDb()
  const groupId = sync.getMeta(db, 'groupId')
  if (!sync.isEnabled(db) || !groupId) return base
  const place = placeOf(readLocal())
  if (!place) return { ...base, state: 'detached', conflicts: sync.listConflicts(db) }
  const devices = known?.groupId === groupId && known.place === placeLabel(place) ? known.devices : []
  return { ...base, state: 'on', folder: placeLabel(place), kind: place.kind, devices, conflicts: sync.listConflicts(db) }
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
async function ensureIdentity(db: Db, store: SyncStore): Promise<string> {
  const local = readLocal()
  const dbDevice = sync.getMeta(db, 'deviceId')
  const dbSeq = Number(sync.getMeta(db, 'seq') ?? '0')
  const foreign = !dbDevice || dbDevice !== local.deviceId
  const behind = !!dbDevice && !foreign && ((await listSeqs(store, dbDevice)).at(-1) ?? 0) > Math.max(dbSeq, outboxSeqs().at(-1) ?? 0)
  if (!foreign && !behind) return dbDevice
  const id = newDeviceId()
  db.transaction(() => {
    if (dbDevice) sync.setCursor(db, dbDevice, dbSeq)
    sync.setMeta(db, 'deviceId', id)
    sync.setMeta(db, 'seq', '0')
    sync.setMeta(db, 'snapshotAt', null)
    sync.setMeta(db, 'snapshotApplied', null)
  })()
  // Change files of the old id that never left this computer: that id's numbering stops here.
  rmSync(outboxDir(), { recursive: true, force: true })
  writeLocal({ ...local, deviceId: id })
  return id
}

/* ---------- Starting, joining, stopping ---------- */

async function chooseFolder(title: string): Promise<string | null> {
  const res = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

interface Chosen {
  store: SyncStore
  place: Place
  password?: string
}

/** A folder from the dialog (or its parent, when the "Kasboek sync" folder itself was picked), or the WebDAV server entered. */
async function choosePlace(title: string, webdav?: WebDavInput): Promise<Chosen | null> {
  if (webdav) {
    const url = normalizeWebDavUrl(webdav.url)
    const user = webdav.user.trim()
    return { store: new WebDavStore({ url, user, password: webdav.password }), place: { kind: 'webdav', url, user }, password: webdav.password }
  }
  const picked = await chooseFolder(title)
  if (!picked) return null
  if (picked.endsWith(SYNC_DIR)) {
    const parent = join(picked, '..')
    const store = new FolderStore(parent)
    if (await readGroup(store)) return { store, place: { kind: 'folder', folder: parent } }
  }
  return { store: new FolderStore(picked), place: { kind: 'folder', folder: picked } }
}

export async function startSync(input: { webdav?: WebDavInput } = {}): Promise<SyncStatus> {
  const db = liveDb()
  if (sync.isEnabled(db) && sync.getMeta(db, 'groupId')) throw new AppError('sync.already', 'This computer already syncs.')
  const chosen = await choosePlace('Choose a folder to sync through', input.webdav)
  if (!chosen) return syncStatus()
  const { store, place } = chosen
  if (await readGroup(store)) throw new AppError('sync.exists', 'This place already holds Kasboek sync data. Use “Join” to sync with it.')
  const groupId = randomBytes(16).toString('hex')
  const deviceId = newDeviceId()
  await store.mkdir(deviceId)
  await store.write('group.json', Buffer.from(JSON.stringify({ format: 1, groupId, createdAt: new Date().toISOString() }, null, 2)))
  db.transaction(() => {
    setSecret(db, 'syncKey', randomBytes(32).toString('hex'))
    setSecret(db, 'webdavPassword', chosen.password ?? null)
    sync.setMeta(db, 'groupId', groupId)
    sync.setMeta(db, 'deviceId', deviceId)
    sync.setMeta(db, 'seq', '0')
    sync.setMeta(db, 'cursors', '{}')
    sync.enable(db, deviceId)
  })()
  rmSync(outboxDir(), { recursive: true, force: true })
  setPlace(place, deviceId)
  await runSync({ forceSnapshot: true })
  return syncStatus()
}

/** Joining: the place (and a WebDAV password) waits here until the snapshot has been imported. */
const pendingJoins = new Map<string, { place: Place; password?: string; tmp?: string }>()

export async function pickJoin(input: { webdav?: WebDavInput } = {}): Promise<PickedTransfer> {
  const chosen = await choosePlace('Choose the sync folder to join', input.webdav)
  if (!chosen) throw new AppError('sync.cancelled', 'No folder chosen.')
  const { store, place } = chosen
  if (!(await readGroup(store))) {
    throw new AppError(
      'sync.not_group',
      place.kind === 'folder'
        ? 'This folder holds no Kasboek sync data. Choose the folder you sync through on the other computer.'
        : 'This WebDAV folder holds no Kasboek sync data. Enter the address the other computer syncs through.'
    )
  }
  // The newest snapshot of any computer in the group.
  let best: { device: string; time: number } | null = null
  for (const d of await listDevices(store)) {
    const snap = (await store.list(d)).find((e) => e.name === 'snapshot.kasboek')
    if (snap && (!best || snap.mtime > best.time)) best = { device: d, time: snap.mtime }
  }
  const data = best ? await store.read(`${best.device}/snapshot.kasboek`) : null
  if (!best || !data) throw new AppError('sync.no_snapshot', 'No computer has finished its first sync here yet. Wait for it to sync, then try again.')
  // Import reads a file: a folder's snapshot directly, a downloaded one from a temporary copy.
  let file: string
  let tmp: string | undefined
  if (place.kind === 'folder') file = join(place.folder, SYNC_DIR, best.device, 'snapshot.kasboek')
  else {
    tmp = file = join(paths.dataDir, `join-${randomUUID()}.kasboek`)
    writeFileSync(file, data, { mode: 0o600 })
  }
  const info = await describeTransfer(file)
  pendingJoins.set(info.token, { place, password: chosen.password, tmp })
  return info
}

/** After an import: when it was a join, start syncing from that place on this computer. */
export async function afterImport(token: string): Promise<void> {
  const pending = pendingJoins.get(token)
  pendingJoins.delete(token)
  if (!pending) return
  if (pending.tmp) rmSync(pending.tmp, { force: true })
  if (!isUnlocked()) return
  const db = liveDb()
  setSecret(db, 'webdavPassword', pending.password ?? null)
  await attachPlace(db, pending.place)
  await runSync({ forceSnapshot: true })
}

async function attachPlace(db: Db, place: Place): Promise<void> {
  const groupId = sync.getMeta(db, 'groupId')
  if (!groupId || !sync.isEnabled(db)) throw new AppError('sync.off', 'This data doesn’t sync.')
  const store = storeFor(place, db)
  if ((await readGroup(store))?.groupId !== groupId) throw new AppError('sync.other_group', 'This place belongs to a different Kasboek sync. Choose the one this data syncs through.')
  setPlace(place)
  await ensureIdentity(db, store)
  lastError = null
}

export async function attach(input: { webdav?: WebDavInput } = {}): Promise<SyncStatus> {
  const chosen = await choosePlace('Choose the sync folder on this computer', input.webdav)
  if (!chosen) return syncStatus()
  const db = liveDb()
  if (chosen.password !== undefined) setSecret(db, 'webdavPassword', chosen.password)
  await attachPlace(db, chosen.place)
  await runSync({ forceSnapshot: true })
  return syncStatus()
}

/** Stops syncing on this computer. The store and the other computers are left as they are. */
export function stopSync(): SyncStatus {
  const db = liveDb()
  db.transaction(() => {
    sync.disable(db)
    for (const k of ['groupId', 'deviceId', 'seq', 'cursors', 'snapshotAt', 'snapshotApplied', 'clock']) sync.setMeta(db, k, null)
    db.prepare('DELETE FROM sync_rows').run()
    db.prepare('DELETE FROM sync_pending').run()
    setSecret(db, 'syncKey', null)
    setSecret(db, 'webdavPassword', null)
  })()
  rmSync(paths.syncFile, { force: true })
  rmSync(outboxDir(), { recursive: true, force: true })
  known = null
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

/** Writes this computer's pending changes as the next numbered file, into the outbox. Synchronous, so it can run right before locking. */
function pushChanges(db: Db, key: Buffer, groupId: string, me: string): number {
  let count = 0
  // The file is written inside the transaction: if writing fails, the changes stay pending.
  db.transaction(() => {
    const changes = sync.flush(db, me)
    if (!changes.length) return
    const seq = Number(sync.getMeta(db, 'seq') ?? '0') + 1
    writeOutbox(seq, seal(key, { kind: 'changes', groupId, device: me, seq }, changes))
    sync.setMeta(db, 'seq', String(seq))
    count = changes.length
  })()
  return count
}

/** This computer's sync settings, when it syncs and the database is open (no store access). */
function localContext(): { db: Db; key: Buffer; groupId: string; place: Place; local: Local } | null {
  if (!isUnlocked()) return null
  const db = liveDb()
  const groupId = sync.getMeta(db, 'groupId')
  if (!sync.isEnabled(db) || !groupId) return null
  const local = readLocal()
  const place = placeOf(local)
  if (!place) return null
  return { db, key: syncKey(db), groupId, place, local }
}

let onApplied: (() => void) | null = null
export function onRemoteChanges(fn: () => void): void {
  onApplied = fn
}

export async function runSync(opts: { forceSnapshot?: boolean } = {}): Promise<void> {
  if (busy) return
  const ctx = localContext()
  if (!ctx) return
  busy = true
  publish()
  const { db, key, groupId, place } = ctx
  const problems: string[] = []
  let received = 0
  let snapshotted = false
  try {
    const store = storeFor(place, db)
    if ((await readGroup(store))?.groupId !== groupId) {
      throw new AppError(
        'sync.other_group',
        place.kind === 'folder' ? 'The sync folder can’t be found, or holds a different Kasboek sync. Choose the folder again.' : 'The WebDAV folder holds no sync data for this Kasboek, or a different one.'
      )
    }
    const me = await ensureIdentity(db, store)
    const pushed = pushChanges(db, key, groupId, me)
    await store.mkdir(me)
    await flushOutbox(store, me)

    // Other computers' files, strictly in order per computer.
    const states = new Map<string, DeviceState>()
    for (const device of await listDevices(store)) {
      if (device === me) continue
      const st = await readState(store, key, groupId, device)
      if (st) states.set(device, st)
      const from = sync.cursors(db)[device] ?? 0
      const seqs = (await listSeqs(store, device)).filter((s) => s > from)
      let next = from + 1
      for (const seq of seqs) {
        if (seq !== next) {
          // A missing file: still on its way, or removed long ago because this computer was away.
          if (st && st.floor >= next) problems.push(`This computer was away too long to catch up with ${st.label}. Stop syncing here and join again.`)
          break
        }
        let changes: sync.Change[]
        try {
          const raw = await store.read(changePath(device, seq))
          if (!raw) break
          changes = open<sync.Change[]>(key, Buffer.from(raw), { kind: 'changes', groupId, device, seq })
        } catch (err) {
          if (isStoreError(err)) throw err
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
    if (opts.forceSnapshot || !snapAt || Date.now() - Date.parse(snapAt) > SNAPSHOT_EVERY_MS) {
      // The assistant's memory stays on this computer: a computer that joins starts without it.
      const tmp = join(paths.dataDir, `sync-snapshot-${randomUUID()}.kasboek`)
      try {
        await writeTransfer(tmp, 'export', { leaveOut: ['memories'] })
        await store.write(`${me}/snapshot.kasboek`, readFileSync(tmp))
      } finally {
        rmSync(tmp, { force: true })
      }
      sync.setMeta(db, 'snapshotAt', new Date().toISOString())
      sync.setMeta(db, 'snapshotApplied', JSON.stringify({ ...sync.cursors(db), [me]: seq }))
      snapshotted = true
    }
    const snapshotApplied = JSON.parse(sync.getMeta(db, 'snapshotApplied') ?? '{}') as Record<string, number>

    // Remove own change files every active computer and every snapshot already has.
    const prevState = await readState(store, key, groupId, me)
    let floor = prevState?.floor ?? 0
    const cutoff = Date.now() - ACTIVE_DAYS * 86400_000
    const active = [...states.values()].filter((s) => Date.parse(s.lastSeen) > cutoff)
    const safe = Math.min(seq, snapshotApplied[me] ?? 0, ...active.map((s) => Math.min(s.applied[me] ?? 0, s.snapshotApplied[me] ?? 0)))
    for (const s of await listSeqs(store, me)) {
      if (s > safe) break
      await store.remove(changePath(me, s))
      floor = Math.max(floor, s)
    }

    const label = hostname() || 'Computer'
    known = {
      groupId,
      place: placeLabel(place),
      devices: [
        { id: me, label, lastSeen: new Date().toISOString(), thisComputer: true },
        ...[...states.entries()].map(([id, s]) => ({ id, label: s.label, lastSeen: s.lastSeen, thisComputer: false })).sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      ]
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
      label,
      lastSeen: new Date().toISOString(),
      seq,
      applied: sync.cursors(db),
      snapshotApplied,
      snapshotAt: sync.getMeta(db, 'snapshotAt'),
      floor
    }
    await store.write(`${me}/state.kbsync`, seal(key, { kind: 'state', groupId, device: me }, state))
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
  // Right before the database closes: write out what changed (into the outbox; it goes up at the next sync).
  onLock(() => {
    try {
      const ctx = localContext()
      // Only under this computer's own id; a database from elsewhere gets its id at the next sync.
      const me = ctx && sync.getMeta(ctx.db, 'deviceId')
      if (ctx && me && me === ctx.local.deviceId) pushChanges(ctx.db, ctx.key, ctx.groupId, me)
    } catch (err) {
      console.error('[sync] before lock failed', err)
    }
  })
}
