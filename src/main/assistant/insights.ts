/**
 * "Get tips from the assistant" on the Overview. Only when the person presses the button, and only after
 * they agreed (once per provider, again when the list of data that is sent changes). What is sent is a short
 * summary of facts found locally, masked and rounded; the assistant picks and words the tips, and code
 * checks every one before it is kept (see core/insight-plan.ts). Nothing here changes bookkeeping data.
 */
import type { Db } from '@core/database'
import { AppError, TruncatedError } from '@core/errors'
import { INSIGHTS_CONSENT_VERSION, SuggestionsPlan, factsPayload, insightsSystem, parseSuggestions, verifySuggestions } from '@core/insight-plan'
import { buildFacts, dismissedKeys, insightsView, saveInsights } from '@core/insights'
import { getSettings, updateSettings } from '@core/settings'
import { localToday } from '@shared/month'
import type { InsightsPreview, InsightsView } from '@shared/types'
import { startupLog } from '../graphics'
import { getPrefs } from '../prefs'
import { broadcast } from '../session'
import { TIME_LIMIT_MS, withTimeLimit } from './jobs'
import { callJson } from './json'
import { activeProvider, requireConfigured } from './provider'

/** Roughly how many characters a token is, for the estimate shown before anything is sent. */
const CHARS_PER_TOKEN = 3

/** The run in progress: one at a time. */
let running: AbortController | null = null

const agreed = (db: Db, provider: string): boolean => {
  const consent = getSettings(db).aiInsightsConsent
  return !!consent && consent.provider === provider && consent.version === INSIGHTS_CONSENT_VERSION
}

/** What would be sent for this month: shown in the dialog where the person agrees, and in the card. */
export function insightsPreview(db: Db, month: string, today = localToday()): InsightsPreview {
  const provider = activeProvider(db)
  requireConfigured(provider)
  const facts = buildFacts(db, month, today)
  const text = factsPayload(facts, { currency: getSettings(db).currency, month, today }).text
  const system = insightsSystem(getPrefs().language)
  return { text, approxTokens: Math.ceil((system.length + text.length) / CHARS_PER_TOKEN), facts: facts.length, providerName: provider.preset.assistantName, company: provider.preset.company }
}

/** Stops the run in progress (the Stop button); nothing happens when none runs. */
export function cancelInsights(): { ok: true } {
  running?.abort('cancelled')
  return { ok: true }
}

export async function runInsights(db: Db, month: string, opts: { consent?: true; today?: string } = {}): Promise<InsightsView> {
  if (running) throw new AppError('insights.busy', 'Tips are already being written.')
  const today = opts.today ?? localToday()
  const provider = activeProvider(db)
  requireConfigured(provider)
  const name = provider.preset.assistantName
  const language = getPrefs().language
  const facts = buildFacts(db, month, today)
  // Nothing to write about: no request, so nothing to agree to.
  if (!facts.length) return insightsView(db, month, language, today)
  if (!agreed(db, provider.preset.id)) {
    if (!opts.consent) throw new AppError('insights.consent_needed', `Agree to send the summary to ${name} first.`)
    updateSettings(db, { aiInsightsConsent: { provider: provider.preset.id, version: INSIGHTS_CONSENT_VERSION, at: new Date().toISOString() } })
  }

  const controller = new AbortController()
  running = controller
  try {
    const context = factsPayload(facts, { currency: getSettings(db).currency, month, today }).text
    const system = insightsSystem(language)
    const timedOut = (): AppError => new AppError('assistant.timeout', `${name} took longer than ${TIME_LIMIT_MS / 60_000} minutes and was stopped. Try again, or choose another model.`)
    const ask = (lower: number): Promise<string> =>
      withTimeLimit(controller.signal, timedOut, (signal) => callJson(db, provider, { system, schema: SuggestionsPlan, context, signal, model: provider.insightsModel, lower, what: 'these tips' }))
    let answer: string
    try {
      answer = await ask(0)
    } catch (err) {
      if (!(err instanceof TruncatedError) || controller.signal.aborted) throw err
      // Cut off: once more with less reasoning, which is what usually used the room up.
      answer = await ask(1).catch((again: unknown) => {
        if (again instanceof TruncatedError) throw new AppError('insights.too_long', `${name}’s answer was too long to fit. Try again, or choose a model with a bigger output limit in Settings → Assistant.`)
        throw again
      })
    }

    const plan = parseSuggestions(answer, name)
    let checked: ReturnType<typeof verifySuggestions>
    try {
      checked = verifySuggestions(plan, facts, dismissedKeys(db), name)
    } catch (err) {
      startupLog(`insights: all ${plan.suggestions.length} tips rejected`)
      throw err
    }
    startupLog(`insights: ${checked.suggestions.length} tips kept, ${checked.rejected} rejected`)
    saveInsights(db, month, { provider: provider.preset.id, model: provider.insightsModel, language, facts, suggestions: checked.suggestions })
    broadcast({ type: 'insights.updated', month })
    return insightsView(db, month, language, today)
  } catch (err) {
    if (controller.signal.aborted) throw new AppError('insights.cancelled', 'Stopped.')
    throw err instanceof AppError ? err : new AppError('assistant.failed', err instanceof Error ? err.message : 'The assistant failed.')
  } finally {
    if (running === controller) running = null
  }
}
