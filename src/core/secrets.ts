/** Secrets (the Anthropic API key) live inside the encrypted database and are never sent to the UI. */
import type { Db } from './database'

export function getSecret(db: Db, key: string): string | null {
  return (db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

export function setSecret(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
  else db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
