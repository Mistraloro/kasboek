import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { MEMORY_LIMIT, forget, forgetAll, looksSensitive, memoryPrompt, memoryState, remember, setMemoryEnabled, updateMemory } from '@core/memory'
import { SYNC_TABLES } from '@core/sync-schema'
import { DEFAULT_PERMISSIONS, needsApproval, presetRules } from '@shared/permissions'

const db = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-mem-')), 'k.db'), randomBytes(32).toString('hex'))

describe('assistant memory', () => {
  it('remembers, changes and forgets items, without duplicates', () => {
    const d = db()
    expect(memoryState(d)).toEqual({ enabled: true, items: [], limit: MEMORY_LIMIT })
    remember(d, '  I get paid on the   25th ', 'person')
    remember(d, 'i get paid on the 25th', 'assistant')
    const s = remember(d, 'Colruyt is Groceries', 'assistant')
    expect(s.items.map((m) => [m.text, m.source])).toEqual([
      ['I get paid on the 25th', 'person'],
      ['Colruyt is Groceries', 'assistant']
    ])
    const id = s.items[1]!.id
    expect(updateMemory(d, id, 'Colruyt and Delhaize are Groceries').items[1]!.text).toBe('Colruyt and Delhaize are Groceries')
    expect(forget(d, [id]).items).toHaveLength(1)
    expect(forgetAll(d).items).toHaveLength(0)
  })

  it('refuses account and card numbers, and stops at the limit', () => {
    const d = db()
    expect(() => remember(d, 'My savings account is BE68 5390 0754 7034', 'assistant')).toThrow(/account or card/)
    expect(() => remember(d, 'Card 4111 1111 1111 1111', 'assistant')).toThrow(/account or card/)
    expect(looksSensitive('Rent of €950 is due on 2026-12-01')).toBe(false)
    expect(looksSensitive('AT25 is not an account')).toBe(false)
    for (let i = 0; i < MEMORY_LIMIT; i++) remember(d, `Fact ${i}`, 'person')
    expect(() => remember(d, 'One more', 'person')).toThrow(/full/)
  })

  it('goes into the prompt only when on, and the assistant cannot save while off', () => {
    const d = db()
    remember(d, 'Answer in Dutch', 'person')
    expect(memoryPrompt(d)).toMatch(/\[\d+\] Answer in Dutch/)
    setMemoryEnabled(d, false)
    expect(memoryPrompt(d)).toBe('')
    expect(() => remember(d, 'Something else', 'assistant')).toThrow(/turned off/)
    // What was saved stays until removed.
    expect(memoryState(d).items).toHaveLength(1)
  })

  it('is not synced, and asks before saving unless allowed', () => {
    expect(SYNC_TABLES.some((s) => s.table === 'memories')).toBe(false)
    expect(needsApproval(DEFAULT_PERMISSIONS, 'memory.remember', { text: 'x' }, 'chat')).toBe(true)
    expect(needsApproval({ ...DEFAULT_PERMISSIONS, mode: 'smart' }, 'memory.remember', { text: 'x' }, 'chat')).toBe(true)
    expect(needsApproval({ ...DEFAULT_PERMISSIONS, mode: 'custom', rules: { ...presetRules('smart'), memory: 'allow' } }, 'memory.remember', { text: 'x' }, 'chat')).toBe(false)
  })
})
