import { DEFAULT_PERMISSIONS } from '@shared/permissions'
import type { ImportReset, Settings } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'

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
  aiPdfModel: '',
  aiProviders: {},
  savedSearches: [],
  aiReasoning: 'default',
  aiCsvReasoning: 'default',
  permissions: DEFAULT_PERMISSIONS,
  assistantEnabled: true,
  memoryEnabled: true,
  pageContextEnabled: true,
  hideAccountNumbers: true,
  aiInsightsConsent: null,
  aiCheckConsent: null
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

/** One setting, read without loading the rest (for code that polls). Same fallback to the default as getSettings. */
export function getSetting<K extends keyof Settings>(db: Db, key: K): Settings[K] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return DEFAULT_SETTINGS[key]
  try {
    return JSON.parse(row.value) as Settings[K]
  } catch {
    return DEFAULT_SETTINGS[key]
  }
}

/** Refuses with `assistant.disabled` while the assistant is switched off: the last stop before anything is sent to an AI provider. */
export function requireAssistant(db: Db): void {
  if (!getSetting(db, 'assistantEnabled')) throw new AppError('assistant.disabled', 'The assistant is turned off. Turn it on in Settings → Assistant.')
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

/** Settings that decide where data is sent, what Claude may do and where files are written, plus the choice to hide account numbers on screen (a file must not switch it off), and the agreements to send tips data and CSV rows to a provider. */
const UNTRUSTED_AFTER_IMPORT = ['aiBaseUrl', 'aiProvider', 'aiProviders', 'permissions', 'mcpEnabled', 'autoBackupFolder', 'autoBackupEnabled', 'memoryEnabled', 'hideAccountNumbers', 'aiInsightsConsent', 'aiCheckConsent'] as const

/**
 * After an import or a sync join: a file from elsewhere must not bring its own AI address, permissions,
 * backup folder, assistant memory, agreements to send tips data or CSV rows, or API keys. These go back to their defaults; everything else (currency, …) stays.
 * That includes hideAccountNumbers: it is ON again after restoring a backup or an export or joining sync, also when the file is the
 * person's own backup with the setting off (a file can't be told from a foreign one), and the person turns it off again if they want.
 * assistantEnabled is the other way round and is NOT in the list: an import must never switch the assistant on. A file that says
 * "off" keeps it off (off is the safe side, and it is the person's own choice), and when the assistant is off on this computer
 * (`assistantOff`) a restored backup, export or sync join is written off too, whatever the file says. A file that says nothing
 * or "on" does not turn it on by itself: at a first setup the default (on) applies as it does for any new database.
 * The sync key and WebDAV password go too, unless this import is a sync join: it needs the key that came with
 * the snapshot, and its caller stores the WebDAV password right afterwards. Otherwise sync is switched off and its
 * state cleared too, as stopSync does: sync without its key can't run. Runs in one transaction, so a failure
 * changes nothing. Returns what actually held something that was reset.
 */
export function resetImportedSettings(db: Db, opts: { keepSyncKey?: boolean; assistantOff?: boolean } = {}): ImportReset[] {
  const hasSetting = (key: string): boolean => db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined
  // A file from an older version may lack tables that a current database has: the staged copy is not migrated.
  const hasTable = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  const hasSecretsTable = hasTable('secrets')
  const hasMemoryTable = hasTable('memories')
  const hasSecret = (where: string): boolean => hasSecretsTable && db.prepare(`SELECT 1 FROM secrets WHERE ${where}`).get() !== undefined
  const syncWasOn = hasTable('sync_flags') && (db.prepare('SELECT enabled FROM sync_flags').get() as { enabled: number } | undefined)?.enabled === 1
  const aiSecrets = "key = 'anthropicApiKey' OR key LIKE 'aiKey.%'"
  const syncSecrets = opts.keepSyncKey ? "key = 'webdavPassword'" : "key IN ('syncKey', 'webdavPassword')"

  const reset: ImportReset[] = []
  const note = (item: ImportReset, found: boolean): void => {
    if (found) reset.push(item)
  }
  return db.transaction(() => {
    note('aiKey', hasSecret(aiSecrets))
    note('aiEndpoint', hasSetting('aiBaseUrl') || hasSetting('aiProvider') || hasSetting('aiProviders'))
    note('permissions', hasSetting('permissions'))
    note('mcp', hasSetting('mcpEnabled'))
    note('autoBackup', hasSetting('autoBackupFolder') || hasSetting('autoBackupEnabled'))
    note('memory', hasSetting('memoryEnabled') || (hasMemoryTable && db.prepare('SELECT 1 FROM memories').get() !== undefined))
    // The WebDAV password of a join is replaced by the caller: nothing to tell the user about.
    note('sync', !opts.keepSyncKey && (hasSecret(syncSecrets) || syncWasOn))

    const del = db.prepare('DELETE FROM settings WHERE key = ?')
    for (const key of UNTRUSTED_AFTER_IMPORT) del.run(key)
    if (opts.assistantOff) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('assistantEnabled', 'false')
    // The key names of keyName() in main/assistant/provider.ts: Claude's own and one per other provider.
    if (hasSecretsTable) db.prepare(`DELETE FROM secrets WHERE ${aiSecrets} OR ${syncSecrets}`).run()
    // Without its key this database can't sync: switch sync off as stopSync does (main/sync/service.ts).
    if (!opts.keepSyncKey) {
      if (hasTable('sync_flags')) db.prepare('UPDATE sync_flags SET enabled = 0, applying = 0').run()
      for (const table of ['sync_outbox', 'sync_rows', 'sync_pending', 'sync_meta']) if (hasTable(table)) db.prepare(`DELETE FROM ${table}`).run()
    }
    if (hasMemoryTable) db.prepare('DELETE FROM memories').run()
    // Tips written for another computer's data are not shown here.
    if (hasTable('insights')) db.prepare('DELETE FROM insights').run()
    return reset
  })()
}
