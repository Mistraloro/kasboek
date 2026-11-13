/**
 * When automatic backups happen:
 *   - a few seconds after an important change (import, undo, restore, bulk edits),
 *   - at most once an hour after other changes,
 *   - once a day regardless,
 *   - and right before Kasboek locks or quits, if anything changed since the last backup.
 * Old backups are thinned out by tier (see core/backup-tiers).
 */
import type { OpName } from '@shared/contract'
import { broadcast, isUnlocked, onLock } from '../session'
import { runAutoBackupIfDue, runAutoBackupSync } from './service'

const IMPORTANT = new Set<OpName>(['import.commit', 'import.undo', 'transfer.import', 'transactions.delete', 'budgets.copyPrevious'])
const SOON_MS = 5_000
const HOURLY_MS = 60 * 60_000

let dirty = false
let lastRun = 0
let timer: NodeJS.Timeout | null = null

function report(p: Promise<string | null>): void {
  p.then((file) => {
    if (file) {
      dirty = false
      lastRun = Date.now()
      broadcast({ type: 'backup.completed', file })
    }
  }).catch((err: unknown) => broadcast({ type: 'backup.failed', message: err instanceof Error ? err.message : String(err) }))
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (dirty && isUnlocked()) report(runAutoBackupIfDue(0))
  }, delay)
}

/** Called after every successful change to the data. */
export function dataChanged(op: OpName, input: unknown): void {
  dirty = true
  const ids = (input as { ids?: unknown[] } | null)?.ids
  const bulk = op === 'transactions.categorize' && Array.isArray(ids) && ids.length >= 10
  const rules = op === 'rules.create' && (input as { applyToExisting?: boolean } | null)?.applyToExisting !== false
  if (IMPORTANT.has(op) || bulk || rules) schedule(SOON_MS)
  else if (Date.now() - lastRun > HOURLY_MS) schedule(60_000)
}

export function startBackupScheduler(): void {
  // Daily backup, also when nothing changed (checked hourly, and shortly after start/unlock).
  setTimeout(() => report(runAutoBackupIfDue()), 15_000)
  setInterval(() => {
    if (dirty && Date.now() - lastRun > HOURLY_MS) schedule(0)
    else report(runAutoBackupIfDue())
  }, HOURLY_MS)
  // Last chance before the database closes (lock, auto-lock, quit).
  onLock(() => {
    if (!dirty) return
    try {
      if (runAutoBackupSync()) dirty = false
    } catch (err) {
      console.error('[backup] before lock failed', err)
    }
  })
}

export function unlocked(): void {
  report(runAutoBackupIfDue())
}
