/**
 * What the assistant does for an open import (checking a CSV file, reading a PDF statement) runs as
 * one job per import: it can be stopped with the Stop button, reports its progress and its end to the
 * import screen, and is cut short when a part takes too long.
 */
import { app } from 'electron'
import { unknownFailure } from '@shared/error-text'
import type { ImportPreview } from '@shared/types'
import { AppError } from '@core/errors'
import { broadcast } from '../session'

/** Each part of a job that runs too long is stopped, so the import screen never waits forever. */
export const TIME_LIMIT_MS = 4 * 60_000
/** Dev builds only: a shorter limit, to test what happens when a part runs out of time. */
export const limitMs = (): number => (!app.isPackaged && Number(process.env['KASBOEK_CHECK_LIMIT_MS'])) || TIME_LIMIT_MS
/** Model calls at the same time: a big file is handled in parts. */
export const PARALLEL = 3

const running = new Map<string, AbortController>()

/** Where a job stands, so the import screen can pick it up again after switching tabs. */
export interface AssistState {
  /** A CSV check or the reading of a PDF statement. */
  kind: 'check' | 'pdf'
  running: boolean
  startedAt: number
  groupsDone: number
  groupsTotal: number
  partsTotal: number
  error: string | null
}
const states = new Map<string, AssistState>()

export function assistStatus(sessionId: string): AssistState | null {
  return states.get(sessionId) ?? null
}

/** Stops a running job for this import (the "Stop" button). */
export function cancelAssist(sessionId: string): void {
  running.get(sessionId)?.abort('cancelled')
}

/** Stops every running job (the app locking). */
export function cancelAllAssists(): void {
  for (const controller of running.values()) controller.abort('cancelled')
}

/**
 * Runs `work` as the job of this import (a job already running for it is stopped first) and tells the
 * import screen when it ends, also one that was opened again while the job ran.
 */
export async function runJob(sessionId: string, kind: AssistState['kind'], work: (signal: AbortSignal, state: AssistState) => Promise<ImportPreview>): Promise<ImportPreview> {
  running.get(sessionId)?.abort('cancelled')
  const controller = new AbortController()
  running.set(sessionId, controller)
  const state: AssistState = { kind, running: true, startedAt: Date.now(), groupsDone: 0, groupsTotal: 0, partsTotal: 0, error: null }
  states.set(sessionId, state)
  let error: AppError | null = null
  try {
    return await work(controller.signal, state)
  } catch (err) {
    error = controller.signal.aborted ? new AppError('assistant.cancelled', 'Check stopped.') : err instanceof AppError ? err : new AppError('assistant.failed', err instanceof Error ? err.message : 'The check failed.', unknownFailure(err))
    throw error
  } finally {
    if (running.get(sessionId) === controller) running.delete(sessionId)
    // A newer job for this import owns the state and the screen now: the old one ends silently.
    if (states.get(sessionId) === state) {
      state.running = false
      state.error = error?.message ?? null
      broadcast({ type: 'import.checkDone', sessionId, error: error ? { code: error.code, message: error.message, ...(error.details && { details: error.details }) } : null })
    }
  }
}

/** Runs one part of a job with its own time limit; `timedOut` makes the error for a part that ran out of time. */
export async function withTimeLimit<T>(signal: AbortSignal, timedOut: () => AppError, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort('timeout'), limitMs())
  try {
    return await work(AbortSignal.any([signal, timeout.signal]))
  } catch (err) {
    if (signal.aborted) throw err
    if (timeout.signal.aborted) throw timedOut()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `work` over the items with at most `limit` at a time; failures are returned, not thrown. */
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { ok: true, value: await work(items[i]!) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}
