// The TypeScript side of the differential scenario harness. A scenario is JSON: a list of `{op, input}` steps, a fixed
// clock and optional prefs.json content. The steps run through the app's own `dispatch` (src/main/ipc.ts, with Electron and
// the session replaced by mocks), on a fresh encrypted database with invented data. `kb-cli scenario` runs the same
// scenario in Rust (rust/crates/kb-cli/src/scenario.rs), and scenarios.spec.ts diffs both outputs.
//
// Masked on both sides, because they are random or follow the wall clock: `uid` values (32 hex digits), every column named
// `at` or ending in `_at`, and the keys createdAt / updatedAt / committedAt and sessionId of results. A string `"$session"` in
// the input of a step stands for the sessionId the latest result had (the id of the open import).
//
// Desktop and network, served the same way by `kb-cli scenario` (scenario.rs documents the keys): `dialogs` answers the file
// dialogs in order (null cancels), `http` answers the requests of `net.fetch` in order (a request for another URL fails) and
// the requests seen are returned as `requests`, `readFiles` returns those files as `files`. `$tmp` in any string of the
// scenario is its temporary folder, and that folder in a result string is printed as `$tmp` again. `service` is for the Rust
// side only (the app's `dispatch` has the desktop operations itself).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Db, openDatabase } from '@core/database'
import type { fxChanged } from '@core/fx'
import type { resetImportedSettings } from '@core/settings'
import type { HttpEntry, MockState } from './electron-mock'

/** An invented key that protects nothing (the same as scenario.rs). */
export const SCENARIO_KEY = '5a5a5a5a5a5a5a5a00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff'
export const DEFAULT_CLOCK = '2026-11-14T10:00:00Z'

export interface Step {
  op: string
  input?: unknown
  actor?: 'user' | 'assistant' | 'system'
}
export interface Scenario {
  name: string
  clock?: string
  languages?: string[]
  prefs?: string | null
  steps: Step[]
  /** Rust side: run the steps through the service (service operations on job threads) instead of a bare core. */
  service?: boolean
  dialogs?: (string | null)[]
  http?: HttpEntry[]
  readFiles?: string[]
}
export interface Outcome {
  results: unknown[]
  dump: Record<string, { columns: string[]; rows: unknown[][] }>
  prefsFile: string | null
  requests?: { method: string; url: string; body: string | null }[]
  files?: Record<string, string | null>
}

type Dispatch = (op: string, input: unknown, actor: 'user' | 'assistant' | 'system') => Promise<unknown>

/** Everything of the app the runner uses, from one module graph: the exchange-rate cache of src/core/fx.ts is module state, so
 *  the database, the operations and `fxChanged` must come from the same instance. */
export interface AppModules {
  dispatch: Dispatch
  openDatabase: typeof openDatabase
  fxChanged: typeof fxChanged
  resetImportedSettings: typeof resetImportedSettings
}

const isTimeColumn = (name: string): boolean => name === 'at' || name.endsWith('_at')
const maskUid = (s: string): string => s.replace(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g, '<uid>')

function cell(value: unknown, column: string): unknown {
  if (value === null || value === undefined) return null
  if (isTimeColumn(column)) return '<time>'
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'string') return maskUid(value)
  return value
}

function maskResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskResult)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, (k === 'createdAt' || k === 'updatedAt' || k === 'committedAt') && typeof v === 'string' ? '<time>' : k === 'sessionId' && typeof v === 'string' ? '<session>' : maskResult(v)])
    )
  }
  return value
}

/** Replaces `$tmp` in every string by `dir`, or (reverse) `dir` by `$tmp`. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]))
  return value
}

/** Replaces the string "$session" anywhere in an input by the id of the import that is open. */
function withSession(value: unknown, id: string | null): unknown {
  if (value === '$session') return id
  if (Array.isArray(value)) return value.map((v) => withSession(v, id))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSession(v, id)]))
  return value
}

function dump(db: Db): Outcome['dump'] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  const out: Outcome['dump'] = {}
  for (const name of names) {
    const stmt = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
    const columns = stmt.columns().map((c) => c.name)
    const pairs = new Map<string, string>()
    const pairColumn = columns.indexOf('transfer_pair')
    out[name] = {
      columns,
      rows: (stmt.raw().all() as unknown[][]).map((row) =>
        row.map((v, i) => {
          if (name === 'transactions' && i === pairColumn && typeof v === 'string') {
            if (!pairs.has(v)) pairs.set(v, `<pair ${pairs.size + 1}>`)
            return pairs.get(v)
          }
          return cell(v, columns[i]!)
        })
      )
    }
  }
  return out
}

export interface RunnerEnv {
  state: MockState
  /** The app's modules, loaded again (fresh module state, so a fresh prefs cache) for every scenario. */
  load: () => Promise<AppModules>
}

export async function runScenario(original: Scenario, env: RunnerEnv): Promise<Outcome> {
  const dir = mkdtempSync(join(process.env.KB_PARITY_TMP ?? tmpdir(), 'kb-scn-'))
  const scenario = mapStrings(original, (s) => s.replaceAll('$tmp', dir)) as Scenario
  const unTmp = (v: unknown): unknown => mapStrings(v, (s) => s.replaceAll(dir, '$tmp'))
  const { state } = env
  state.dialogs = [...(scenario.dialogs ?? [])]
  state.http = [...(scenario.http ?? [])]
  const requests: NonNullable<Outcome['requests']> = []
  state.requests = requests
  state.userData = dir
  state.languages = scenario.languages ?? ['en']
  state.unlocked = true
  const app = await env.load()
  const { dispatch, fxChanged, resetImportedSettings } = app
  const db = app.openDatabase(join(dir, 'kasboek.db'), SCENARIO_KEY)
  state.db = db
  if (typeof scenario.prefs === 'string') writeFileSync(join(dir, 'prefs.json'), scenario.prefs)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.clock ?? DEFAULT_CLOCK))
  try {
    const results: unknown[] = []
    let session: string | null = null
    for (const step of scenario.steps) {
      let result: unknown
      switch (step.op) {
        case '@lock':
          state.unlocked = false
          result = { ok: true, data: null }
          break
        case '@unlock':
          state.unlocked = true
          result = { ok: true, data: null }
          break
        case '@sql':
          db.exec((step.input as { sql: string }).sql)
          result = { ok: true, data: null }
          break
        case '@fxReload':
          fxChanged(db)
          result = { ok: true, data: null }
          break
        case '@resetImportedSettings':
          {
            const opts = (step.input ?? {}) as { keepSyncKey?: boolean; assistantOff?: boolean }
            result = { ok: true, data: resetImportedSettings(db, { keepSyncKey: opts.keepSyncKey ?? false, assistantOff: opts.assistantOff ?? false }) }
          }
          break
        default:
          result = await dispatch(step.op, step.input === undefined ? null : withSession(step.input, session), step.actor ?? 'user')
      }
      const found = (result as { ok?: boolean; data?: { sessionId?: unknown } } | undefined)?.data?.sessionId
      if (typeof found === 'string') session = found
      results.push(unTmp(maskResult(JSON.parse(JSON.stringify(result)))))
    }
    let prefsFile: string | null = null
    try {
      prefsFile = readFileSync(join(dir, 'prefs.json'), 'utf8')
    } catch {
      prefsFile = null
    }
    const outcome: Outcome = { results, dump: dump(db), prefsFile }
    if (requests.length > 0) outcome.requests = unTmp(requests) as typeof requests
    if (scenario.readFiles) {
      outcome.files = Object.fromEntries(
        scenario.readFiles.map((path, i) => {
          try {
            return [original.readFiles![i]!, readFileSync(path, 'utf8')]
          } catch {
            return [original.readFiles![i]!, null]
          }
        })
      )
    }
    return outcome
  } finally {
    vi.useRealTimers()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
