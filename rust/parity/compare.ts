// The comparison of the scenario specs: a scenario runs through the app's own dispatch (TypeScript) and through `kb-cli scenario`
// (Rust), and every op result and a dump of all tables must be equal.
//
// Where the two sides cannot be equal and are compared by code only: the message of `op.invalid_input` (zod's text against
// serde's) and of `op.failed` (the TypeScript one comes from the engine's own error).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { MockState } from './electron-mock'
import { cliText } from './helpers'
import { runScenario, type Outcome, type Scenario } from './scenario-runner'

export async function load() {
  // A fresh module state per scenario: prefs.json is cached by src/main/prefs.ts.
  vi.resetModules()
  const { dispatch } = await import('../../src/main/ipc')
  const { openDatabase } = await import('@core/database')
  const { fxChanged } = await import('@core/fx')
  const { resetImportedSettings } = await import('@core/settings')
  return { dispatch: dispatch as never, openDatabase, fxChanged, resetImportedSettings }
}

/** Sorted keys, so objects compare independent of key order; messages that cannot match are dropped. */
export function canonical(value: unknown, path = ''): unknown {
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
export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
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

/** Runs a scenario on both sides and fails with the first difference; returns the TypeScript outcome. */
export function comparer(state: MockState, tmpDir: string) {
  return async function compare(scenario: Scenario, stepNames = true): Promise<Outcome & { rustMs: number; tsMs: number }> {
    const file = join(tmpDir, 'scenario.json')
    writeFileSync(file, JSON.stringify(scenario))
    const rustStart = performance.now()
    const rust = JSON.parse(cliText(['scenario', file])) as Outcome
    const rustMs = performance.now() - rustStart
    const tsStart = performance.now()
    const ts = await runScenario(scenario, { state, load })
    const tsMs = performance.now() - tsStart
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
    expect(canonical(rust.requests)).toEqual(canonical(ts.requests))
    expect(canonical(rust.files)).toEqual(canonical(ts.files))
    return { ...ts, rustMs, tsMs }
  }
}
