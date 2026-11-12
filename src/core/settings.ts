import type { Settings } from '@shared/types'
import type { Db } from './database'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  language: 'en',
  formatLocale: 'en-BE',
  currency: 'EUR',
  autoBackupEnabled: false,
  autoBackupFolder: null,
  autoBackupKeep: 10,
  lastBackupAt: null,
  lastBackupFile: null
}

export function getSettings(db: Db): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const stored: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value)
    } catch {
      // Ignore a damaged value and fall back to the default.
    }
  }
  const merged = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (key in stored) (merged as Record<string, unknown>)[key] = stored[key]
  }
  return merged
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue
      upsert.run(key, JSON.stringify(value))
    }
  })()
  return getSettings(db)
}
