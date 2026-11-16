import { DEFAULT_PERMISSIONS } from '@shared/permissions'
import type { ImportReset, Settings } from '@shared/types'
import type { Db } from './database'

export const DEFAULT_SETTINGS: Settings = {
  currency: 'EUR',
  fxAutoUpdate: false,
  fxLastEcbUpdateAt: null,
  autoBackupEnabled: false,
  autoBackupFolder: null,
  autoBackupKeep: 10,
  lastBackupAt: null,
  lastBackupFile: null,
  chatModel: 'claude-sonnet-5-5',
  chatEffort: 'medium',
  csvModel: 'claude-opus-5-5',
  csvEffort: 'medium',
  mcpEnabled: false,
  aiProvider: 'anthropic',
  aiBaseUrl: null,
  aiChatModel: '',
  aiCsvModel: '',
  savedSearches: [],
  aiReasoning: 'default',
  aiCsvReasoning: 'default',
  permissions: DEFAULT_PERMISSIONS,
  memoryEnabled: true
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

/** Settings that decide where data is sent, what Claude may do and where files are written. */
const UNTRUSTED_AFTER_IMPORT = ['aiBaseUrl', 'aiProvider', 'permissions', 'mcpEnabled', 'autoBackupFolder', 'autoBackupEnabled', 'memoryEnabled'] as const

/**
 * After an import or a sync join: a file from elsewhere must not bring its own AI address, permissions,
 * backup folder, assistant memory or API keys. These go back to their defaults; everything else (currency, …) stays.
 * The sync key and WebDAV password go too, unless this import is a sync join: it needs the key that came with
 * the snapshot, and its caller stores the WebDAV password right afterwards. Runs in one transaction, so a failure
 * changes nothing. Returns what actually held something that was reset.
 */
export function resetImportedSettings(db: Db, opts: { keepSyncKey?: boolean } = {}): ImportReset[] {
  const hasSetting = (key: string): boolean => db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined
  const hasSecret = (where: string): boolean => db.prepare(`SELECT 1 FROM secrets WHERE ${where}`).get() !== undefined
  // A file from an older version has no memory table yet.
  const hasMemoryTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get() !== undefined
  const aiSecrets = "key = 'anthropicApiKey' OR key LIKE 'aiKey.%'"
  const syncSecrets = opts.keepSyncKey ? "key = 'webdavPassword'" : "key IN ('syncKey', 'webdavPassword')"

  const reset: ImportReset[] = []
  const note = (item: ImportReset, found: boolean): void => {
    if (found) reset.push(item)
  }
  return db.transaction(() => {
    note('aiKey', hasSecret(aiSecrets))
    note('aiEndpoint', hasSetting('aiBaseUrl') || hasSetting('aiProvider'))
    note('permissions', hasSetting('permissions'))
    note('mcp', hasSetting('mcpEnabled'))
    note('autoBackup', hasSetting('autoBackupFolder') || hasSetting('autoBackupEnabled'))
    note('memory', hasSetting('memoryEnabled') || (hasMemoryTable && db.prepare('SELECT 1 FROM memories').get() !== undefined))
    // The WebDAV password of a join is replaced by the caller: nothing to tell the user about.
    note('sync', !opts.keepSyncKey && hasSecret(syncSecrets))

    const del = db.prepare('DELETE FROM settings WHERE key = ?')
    for (const key of UNTRUSTED_AFTER_IMPORT) del.run(key)
    // The key names of keyName() in main/assistant/provider.ts: Claude's own and one per other provider.
    db.prepare(`DELETE FROM secrets WHERE ${aiSecrets} OR ${syncSecrets}`).run()
    if (hasMemoryTable) db.prepare('DELETE FROM memories').run()
    return reset
  })()
}
