/**
 * "Erase" does not delete: the database, the account file and the safety copies are moved into
 * erased/<time>/ inside the data folder, and Kasboek starts fresh. Everything stays encrypted, so
 * nothing is exposed; the original password or recovery key brings it back (restoreErased). After
 * 30 days the database and account are removed for good. Kept free of Electron so it can be tested.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@core/errors'

export interface DataLayout {
  dataDir: string
  dbFile: string
  accountFile: string
  /** Phase 1 key file: without it the old database can't be opened, so it travels with the database. */
  legacyKeystoreFile: string
  safetyDir: string
}

export const QUARANTINE_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const ENTRY = /^\d{10,}$/
const quarantineDir = (l: DataLayout): string => join(l.dataDir, 'erased')

/** The files that belong to one copy, by their name inside an entry. */
const parts = (l: DataLayout): { name: string; live: string }[] => [
  { name: 'account.json', live: l.accountFile },
  { name: 'kasboek.db', live: l.dbFile },
  { name: 'keystore.json', live: l.legacyKeystoreFile }
]

/** Quarantined copies, newest first. */
export async function listErased(l: DataLayout): Promise<{ name: string; erasedAt: number }[]> {
  let names: string[]
  try {
    names = await readdir(quarantineDir(l))
  } catch {
    return []
  }
  return names
    .filter((n) => ENTRY.test(n))
    .map((name) => ({ name, erasedAt: Number(name) }))
    .sort((a, b) => b.erasedAt - a.erasedAt)
}

/** Moves the data aside. Returns the entry name, or null when there was nothing to move. */
export async function quarantineData(l: DataLayout, now = Date.now()): Promise<string | null> {
  const name = String(now)
  const dir = join(quarantineDir(l), name)
  await mkdir(dir, { recursive: true })
  let moved = false
  // The account goes first: if this stops half-way, Kasboek sees "no account" and keeps the old database aside, never pairs it with a new key.
  for (const p of parts(l)) {
    if (!existsSync(p.live)) continue
    await rename(p.live, join(dir, p.name))
    moved = true
  }
  if (existsSync(l.safetyDir)) {
    await rename(l.safetyDir, join(dir, 'safety-backups'))
    moved = true
  }
  if (!moved) {
    await rmdir(dir)
    return null
  }
  return name
}

/** Puts safety copies back into the live folder; a file that is already there keeps its place and the returning one gets a prefix. */
async function returnSafetyCopies(l: DataLayout, from: string): Promise<void> {
  if (!existsSync(from)) return
  await mkdir(l.safetyDir, { recursive: true })
  for (const f of await readdir(from)) {
    const target = existsSync(join(l.safetyDir, f)) ? join(l.safetyDir, `restored-${f}`) : join(l.safetyDir, f)
    await rename(join(from, f), target)
  }
}

/** Brings the newest copy back. Only when no account exists here: it would replace it. */
export async function restoreErased(l: DataLayout): Promise<void> {
  if (existsSync(l.accountFile)) throw new AppError('auth.restore_blocked', 'Kasboek is already set up. Restoring erased data is only possible on the first screen.')
  const newest = (await listErased(l))[0]
  if (!newest) throw new AppError('auth.nothing_erased', 'There is no erased data to restore.')
  const dir = join(quarantineDir(l), newest.name)
  // A database that is here without an account can't be opened by anyone: keep it aside, as setup does.
  if (existsSync(l.dbFile) && existsSync(join(dir, 'kasboek.db'))) await rename(l.dbFile, `${l.dbFile}.orphaned-${Date.now()}`)
  // The account comes back last: an account without its database would start an empty one.
  for (const p of [...parts(l)].reverse()) {
    if (existsSync(join(dir, p.name))) await rename(join(dir, p.name), p.live)
  }
  await returnSafetyCopies(l, join(dir, 'safety-backups'))
  await rm(dir, { recursive: true, force: true })
}

/**
 * Removes copies for good: every one (`all`), or the ones older than 30 days. An expired copy loses its
 * database and account, but its safety copies go back to the safety folder: erasing never deletes those.
 */
export async function purgeErased(l: DataLayout, opts: { all?: boolean; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  let removed = 0
  for (const e of await listErased(l)) {
    if (!opts.all && now - e.erasedAt < QUARANTINE_DAYS * DAY) continue
    const dir = join(quarantineDir(l), e.name)
    if (!opts.all) await returnSafetyCopies(l, join(dir, 'safety-backups'))
    await rm(dir, { recursive: true, force: true })
    removed++
  }
  return removed
}
