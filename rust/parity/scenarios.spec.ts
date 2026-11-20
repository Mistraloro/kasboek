// Differential scenarios: every file in rust/parity/scenarios (and the generated household) runs through the app's own
// dispatch (TypeScript) and through `kb-cli scenario` (Rust, kb-core), on a fresh invented encrypted database. Every op
// result and a dump of all tables (random ids and times masked) must be equal.
//
// The comparison is in compare.ts.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { MockState } from './electron-mock'
import { comparer } from './compare'
import { tempDir } from './helpers'
import { household } from './household'
import type { Scenario } from './scenario-runner'

process.env.TZ = 'UTC'
const state = vi.hoisted((): MockState => ({ userData: '', db: null, unlocked: true, languages: ['en'] }))
vi.mock('electron', async () => (await import('./electron-mock')).electronMock(state))
vi.mock('../../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../../src/main/session', async () => (await import('./electron-mock')).sessionMock(state))

const DIR = resolve(import.meta.dirname, 'scenarios')
const tmp = tempDir('kb-scn-files-')
afterAll(() => tmp.remove())

const compare = comparer(state, tmp.dir)

describe('scenarios: the app’s own dispatch against kb-core', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  it('has at least 40 scenarios', () => expect(files.length).toBeGreaterThanOrEqual(40))
  for (const f of files) {
    it(f.replace(/\.json$/, ''), async () => {
      await compare(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Scenario)
    })
  }
})

describe('a seeded household (about 2,000 transactions)', () => {
  it('lists, filters, pages and totals the same', async () => {
    const scenario = household(20261114)
    expect(scenario.steps.length).toBeGreaterThan(2000)
    const outcome = await compare(scenario, false)
    // Guard against comparing two empty answers: the data is there, and the lists return it.
    const lists = scenario.steps.flatMap((s, i) => (s.op === 'transactions.list' ? [outcome.results[i] as { ok: boolean; data: { items: unknown[]; total: number } }] : []))
    expect(lists.every((l) => l.ok)).toBe(true)
    expect(Math.max(...lists.map((l) => l.data.total))).toBeGreaterThan(1900)
    expect(lists.filter((l) => l.data.items.length > 0).length).toBeGreaterThan(100)
    expect(outcome.results.filter((r) => (r as { ok: boolean }).ok).length).toBeGreaterThan(scenario.steps.length * 0.97)
    // The slice 2 calls compare real answers too, not two lots of empty ones.
    const data = (op: string): { ok: boolean; data: any }[] => scenario.steps.flatMap((s, i) => (s.op === op ? [outcome.results[i] as { ok: boolean; data: any }] : []))
    expect(data('summary.month').every((r) => r.ok) && data('summary.month').length).toBe(24)
    expect(data('summary.month').filter((r) => r.data.spendingCents > 0 && r.data.byCategory.length > 3).length).toBeGreaterThan(12)
    expect(data('summary.review').every((r) => r.ok)).toBe(true)
    expect(data('summary.review').filter((r) => r.data.categories.length > 0).length).toBeGreaterThan(12)
    expect(data('recurring.list').every((r) => r.ok)).toBe(true)
    expect(data('recurring.list')[0]!.data.items.length).toBeGreaterThan(2)
    expect(data('recurring.list').at(-1)!.data.items.length).toBeGreaterThan(2)
    expect(data('transfers.find')[0]!.data.length).toBeGreaterThan(10)
    expect(data('transfers.pair')[0]!.data.paired).toBeGreaterThan(8)
    expect(data('networth.summary').every((r) => r.ok && r.data.accounts.length === 5)).toBe(true)
    expect(data('rules.create').filter((r) => r.ok).length).toBeGreaterThan(3)
  }, 300_000)
})
