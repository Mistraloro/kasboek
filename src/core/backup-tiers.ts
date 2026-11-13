/**
 * Which automatic backups to keep: everything from the last 24 hours, the newest one per day for
 * the last 30 days, and the newest one per month for the last 12 months. Each backup is a complete,
 * independent export, so deleting any of them never affects the others.
 */
export interface BackupEntry {
  name: string
  time: number
}

export type Tier = 'recent' | 'daily' | 'monthly'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10)
const monthKey = (t: number): string => new Date(t).toISOString().slice(0, 7)

export function planRetention(entries: BackupEntry[], now = Date.now()): { keep: Map<string, Tier>; remove: string[] } {
  const sorted = [...entries].sort((a, b) => b.time - a.time)
  const keep = new Map<string, Tier>()
  const days = new Set<string>()
  const months = new Set<string>()
  for (const e of sorted) {
    const age = now - e.time
    if (age < DAY) keep.set(e.name, 'recent')
    else if (age < 30 * DAY) {
      if (!days.has(dayKey(e.time))) {
        days.add(dayKey(e.time))
        keep.set(e.name, 'daily')
      }
    } else if (age < 365 * DAY) {
      if (!months.has(monthKey(e.time))) {
        months.add(monthKey(e.time))
        keep.set(e.name, 'monthly')
      }
    }
  }
  return { keep, remove: sorted.filter((e) => !keep.has(e.name)).map((e) => e.name) }
}

/** Reads the time from a name like kasboek-backup-2026-11-13_092130.kasboek (local time). */
export function timeFromName(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[]
  return new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime()
}
