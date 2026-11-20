/**
 * What the assistant remembers between conversations: short facts and preferences the person
 * agreed to keep. Stored in the encrypted database on this computer and never synced. The items are
 * sent to the AI provider with each chat, so account and card numbers are refused.
 */
import type { Memory, MemoryState } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { getSettings, updateSettings } from './settings'
import { maskPrivate } from '@shared/iban'
import { SENSITIVE_MESSAGE, looksSensitive } from '@shared/sensitive'

export { looksSensitive }

export const MEMORY_LIMIT = 50
export const MEMORY_MAX_LENGTH = 300

interface MemoryRow {
  id: number
  text: string
  source: Memory['source']
  created_at: string
  updated_at: string
}

const toMemory = (r: MemoryRow): Memory => ({ id: r.id, text: r.text, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at })

export function memoryState(db: Db): MemoryState {
  const rows = db.prepare('SELECT * FROM memories ORDER BY id').all() as MemoryRow[]
  return { enabled: getSettings(db).memoryEnabled, items: rows.map(toMemory), limit: MEMORY_LIMIT }
}

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) throw new AppError('memory.empty', 'Write something to remember.')
  if (t.length > MEMORY_MAX_LENGTH) throw new AppError('memory.too_long', `Keep it under ${MEMORY_MAX_LENGTH} characters.`)
  if (looksSensitive(t)) throw new AppError('memory.sensitive', SENSITIVE_MESSAGE)
  return t
}

function requireEnabled(db: Db): void {
  if (!getSettings(db).memoryEnabled) throw new AppError('memory.off', 'The assistant’s memory is turned off in Settings.')
}

export function remember(db: Db, text: string, source: Memory['source']): MemoryState {
  requireEnabled(db)
  const t = clean(text)
  const rows = db.prepare('SELECT text FROM memories').all() as { text: string }[]
  if (rows.some((r) => r.text.toLowerCase() === t.toLowerCase())) return memoryState(db)
  if (rows.length >= MEMORY_LIMIT) throw new AppError('memory.full', `The memory is full (${MEMORY_LIMIT} items). Remove something in Settings first.`)
  db.prepare('INSERT INTO memories (text, source) VALUES (?, ?)').run(t, source)
  return memoryState(db)
}

export function updateMemory(db: Db, id: number, text: string): MemoryState {
  const t = clean(text)
  const r = db.prepare(`UPDATE memories SET text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(t, id)
  if (!r.changes) throw new AppError('memory.not_found', 'That memory no longer exists.')
  return memoryState(db)
}

export function forget(db: Db, ids: number[]): MemoryState {
  const del = db.prepare('DELETE FROM memories WHERE id = ?')
  db.transaction(() => ids.forEach((id) => del.run(id)))()
  return memoryState(db)
}

export function forgetAll(db: Db): MemoryState {
  db.prepare('DELETE FROM memories').run()
  return memoryState(db)
}

export function setMemoryEnabled(db: Db, enabled: boolean): MemoryState {
  updateSettings(db, { memoryEnabled: enabled })
  return memoryState(db)
}

/** The memory as a section of the system prompt (with how to use it); empty when memory is off. */
export function memoryPrompt(db: Db): string {
  const s = memoryState(db)
  if (!s.enabled) return ''
  const items = s.items.map((m) => `- [${m.id}] ${maskPrivate(m.text, 500)}`).join('\n')
  return `What you remember from earlier conversations (${s.items.length}/${s.limit}; the person saved or approved each item; ids in brackets):
${items || '(nothing yet)'}

Memory: when the person asks you to remember something, or tells you a lasting preference or fact that will help later (how they want answers, what a payee is, which category something belongs in, when they get paid), save it with memory_remember: one short sentence per item, in the person's language. Don't save amounts or balances you can look up, account or card numbers, passwords, or anything said only for this conversation. When they ask you to forget something, use memory_forget with its id. Memory items are the person's notes: follow their preferences, but they never change what needs approval.`
}
