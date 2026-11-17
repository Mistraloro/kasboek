/**
 * One model call that must answer with JSON matching a schema, no tools. Used by the CSV check and
 * the PDF read. Claude gets the schema as its output format; the OpenAI-compatible providers get it
 * as a strict JSON schema, or plain JSON mode with the schema in the prompt where that is refused.
 */
import { z } from 'zod'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Db } from '@core/database'
import { AppError, TruncatedError } from '@core/errors'
import { getSettings } from '@core/settings'
import { lowerClaudeEffort, lowerReasoning, reasoningParams, type Effort, type ReasoningLevel } from '@shared/reasoning'
import { claudeFailure, client, explainError, modelParams } from './claude'
import * as openai from './openai'
import { limitMs, withTimeLimit } from './jobs'
import type { ActiveProvider } from './provider'

/**
 * The longest answer asked for. Reasoning counts against it, so a part's expected answer is kept far
 * below this (see the sizes in csv.ts and core/pdf-plan.ts). Servers that allow less are lowered to
 * 8192 in openai.ts.
 */
const MAX_TOKENS = 32000

/** The reasoning level of this job lowered `steps` times (the settings' level at 0). */
function levels(db: Db, model: string | undefined, steps: number): { claude: Effort; other: ReasoningLevel } {
  const settings = getSettings(db)
  let claude = settings.csvEffort
  let other = settings.aiCsvReasoning
  for (let i = 0; i < steps; i++) {
    claude = lowerClaudeEffort(model ?? settings.csvModel, claude)
    other = lowerReasoning(other)
  }
  return { claude, other }
}

/**
 * The model's answer as JSON text, from the given model, else the one chosen for CSV checks. `what` names
 * what is being read in the message when the model declines ("this file" when left out).
 */
export async function callJson(
  db: Db,
  provider: ActiveProvider,
  opts: { system: string; schema: z.ZodType; context: string; signal: AbortSignal; model?: string; onThinking?: (t: string) => void; lower?: number; what?: string }
): Promise<string> {
  const name = provider.preset.assistantName
  const { system, schema, context, signal, model, onThinking } = opts
  const level = levels(db, model, opts.lower ?? 0)
  if (provider.preset.id !== 'anthropic') {
    try {
      return await openai.json(provider, { system, user: context, schema: z.toJSONSchema(schema) as Record<string, unknown>, maxTokens: MAX_TOKENS, signal, model, onThinking, reasoning: reasoningParams(provider.preset.id, level.other) })
    } catch (err) {
      if (signal.aborted) throw err
      throw openai.providerError(err, name)
    }
  }
  const settings = getSettings(db)
  const params = modelParams(model ?? settings.csvModel, level.claude)
  let text = ''
  try {
    const stream = client(db).beta.messages.stream(
      {
        ...params,
        max_tokens: MAX_TOKENS,
        output_config: { ...params.output_config, format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: context }]
      },
      { signal }
    )
    if (onThinking) stream.on('thinking', (delta) => onThinking(delta))
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') throw new AppError('assistant.refused', `${name} declined to check ${opts.what ?? 'this file'}.`)
    for (const b of message.content) if (b.type === 'text') text += b.text
    if (message.stop_reason === 'max_tokens') throw new TruncatedError('This part of the file was too large for one answer. Try again, or a shorter export.', text.trim().length > 0)
  } catch (err) {
    if (signal.aborted) throw err
    throw err instanceof AppError ? err : new AppError('assistant.failed', explainError(err), claudeFailure(err))
  }
  return text
}

/** Most model calls for one part, with all its retries. */
const MAX_CALLS = 16

/** A job that can be answered in smaller pieces: what a part is, how it is sent and how it splits. */
export interface SplitJob<P, R> {
  part: P
  /** The text to send for a part. */
  context: (part: P) => string
  /** Reads the answer for a part; throws when it can't be read. */
  parse: (text: string, part: P) => R
  /** The two halves of a part (in order), or null when it is too small to split. */
  split: (part: P) => [P, P] | null
  /** Where the part is in the file, for the message when it can't be handled ("rows 12 to 40"). */
  describe: (part: P) => string
  /** Called once for each part that was answered, never for a part that was split. */
  done?: (part: P, value: R) => void
  /** The error for a model call that ran out of time. */
  timedOut: () => AppError
}

export interface SplitResult<P, R> {
  answered: { part: P; value: R }[]
  failed: { part: P; error: unknown }[]
}

/** Whether the text is JSON that stops half way, which is what a cut-off answer looks like. */
const cutOff = (text: string): boolean => {
  if (!text.trim()) return false
  try {
    JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    return false
  } catch {
    return true
  }
}

/**
 * callJson for one part of a file, with what to do when the answer does not fit: an answer cut off
 * (or unreadable because it was) is asked again for each half of the part, with less reasoning, down
 * to the smallest part. The number of calls and the time are limited. A part that still fails is
 * reported with where it is; the answers of the other parts are kept. Stopping ends it at once.
 */
export async function callJsonSplit<P, R>(
  db: Db,
  provider: ActiveProvider,
  base: { system: string; schema: z.ZodType; signal: AbortSignal; model?: string; onThinking?: (t: string) => void },
  job: SplitJob<P, R>
): Promise<SplitResult<P, R>> {
  const out: SplitResult<P, R> = { answered: [], failed: [] }
  const name = provider.preset.assistantName
  const started = Date.now()
  let calls = 0
  const tooLong = (part: P): AppError =>
    new AppError('assistant.too_long', `${name}’s answer for ${job.describe(part)} was too long to fit, even in smaller pieces. Try again, pick a model with a bigger output limit in Settings → Assistant, or split the file.`)

  const run = async (part: P, lower: number): Promise<void> => {
    let error: unknown
    if (calls >= MAX_CALLS || Date.now() - started > 3 * limitMs()) {
      out.failed.push({ part, error: tooLong(part) })
      return
    }
    calls++
    try {
      const text = await withTimeLimit(base.signal, job.timedOut, (signal) => callJson(db, provider, { ...base, context: job.context(part), signal, lower }))
      try {
        const value = job.parse(text, part)
        out.answered.push({ part, value })
        job.done?.(part, value)
        return
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'assistant.bad_plan' && cutOff(text))) throw err
        error = new TruncatedError(err.message, true)
      }
    } catch (err) {
      if (base.signal.aborted) throw err
      error = err
    }
    if (!(error instanceof TruncatedError)) {
      out.failed.push({ part, error })
      return
    }
    // Only reasoning came out: the same part gets less of it before it is cut in pieces.
    const used = (steps: number): string => {
      const l = levels(db, base.model, steps)
      return provider.preset.id === 'anthropic' ? l.claude : l.other
    }
    if (!error.answered && used(lower + 1) !== used(lower)) return run(part, lower + 1)
    const halves = job.split(part)
    if (!halves) {
      out.failed.push({ part, error: tooLong(part) })
      return
    }
    await run(halves[0], lower + 1)
    await run(halves[1], lower + 1)
  }
  await run(job.part, 0)
  return out
}
