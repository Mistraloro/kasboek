// Differential scenarios: every file in rust/parity/scenarios (and the generated household) runs through the app's own
// dispatch (TypeScript) and through `kb-cli scenario` (Rust, kb-core), on a fresh invented encrypted database. Every op
// result and a dump of all tables (random ids and times masked) must be equal.
//
// Where the two sides cannot be equal and are compared by code only: the message of `op.invalid_input` (zod's text against
// serde's) and of `op.failed` (the TypeScript one comes from the engine's own error).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { MockState } from './electron-mock'
import { cliText, tempDir } from './helpers'
import { household } from './household'
import { runScenario, type Outcome, type Scenario } from './scenario-runner'

process.env.TZ = 'UTC'
const state = vi.hoisted((): MockState => ({ userData: '', db: null, unlocked: true, languages: ['en'] }))
vi.mock('electron', async () => (await import('./electron-mock')).electronMock(state))
vi.mock('../../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../../src/main/session', async () => (await import('./electron-mock')).sessionMock(state))

const DIR = resolve(import.meta.dirname, 'scenarios')
const tmp = tempDir('kb-scn-files-')
afterAll(() => tmp.remove())

async function load() {
  // A fresh module state per scenario: prefs.json is cached by src/main/prefs.ts.
  vi.resetModules()
  const { dispatch } = await import('../../src/main/ipc')
  const { openDatabase } = await import('@core/database')
  const { fxChanged } = await import('@core/fx')
  const { resetImportedSettings } = await import('@core/settings')
  return { dispatch: dispatch as never, openDatabase, fxChanged, resetImportedSettings }
}

/** Sorted keys, so objects compare independent of key order; messages that cannot match are dropped. */
function canonical(value: unknown, path = ''): unknown {
  if (Array.isArray(value)) return value.map((v, i) => canonical(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const codeOnly = typeof o.code === 'string' && (o.code === 'op.invalid_input' || o.code === 'op.failed')
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => !(codeOnly && k === 'message'))
        .map((k) => [k, canonical(o[k], `${path}.${k}`)])
    )
  }
  return value
}

/** The first difference, as text a person can read. */
function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
  } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference((a as never)[k], (b as never)[k], `${path}.${k}`)
      if (d) return d
    }
  }
  return `${path}: TS ${JSON.stringify(a)?.slice(0, 300)} <> Rust ${JSON.stringify(b)?.slice(0, 300)}`
}

async function compare(scenario: Scenario, stepNames = true): Promise<Outcome> {
  const file = join(tmp.dir, 'scenario.json')
  writeFileSync(file, JSON.stringify(scenario))
  const rust = JSON.parse(cliText(['scenario', file])) as Outcome
  const ts = await runScenario(scenario, { state, load })
  expect(rust.results.length).toBe(ts.results.length)
  ts.results.forEach((r, i) => {
    const d = firstDifference(canonical(r), canonical(rust.results[i]))
    if (d) {
      const step = scenario.steps[i]!
      expect.fail(`step ${i} ${step.op} ${stepNames ? JSON.stringify(step.input ?? null).slice(0, 200) : ''}\n${d}`)
    }
  })
  const dump = firstDifference(canonical(ts.dump), canonical(rust.dump))
  if (dump) expect.fail(`database dump: ${dump}`)
  expect(canonical(rust.prefsFile)).toEqual(canonical(ts.prefsFile))
  return ts
}

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
  }, 300_000)
})
