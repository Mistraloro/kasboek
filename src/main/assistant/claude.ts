/** Talking to the Anthropic API. Only the main process does this; the key never reaches the page. */
import Anthropic from '@anthropic-ai/sdk'
import { app } from 'electron'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret } from '@core/secrets'
import { requireAssistant } from '@core/settings'
import type { ErrorDetails, ProviderFailureKind } from '@shared/error-text'
import { claudeEffort, type Effort } from '@shared/reasoning'

export const API_KEY = 'anthropicApiKey'

// Dev/test only: point at a local mock of the API. Ignored in packaged builds.
const baseURL = (): string | undefined => (app.isPackaged ? undefined : process.env['KASBOEK_ANTHROPIC_BASE_URL'] || undefined)

export function client(db: Db): Anthropic {
  requireAssistant(db)
  const apiKey = getSecret(db, API_KEY)
  if (!apiKey) throw new AppError('assistant.no_key', 'Add your Anthropic API key in Settings → Assistant first.')
  return new Anthropic({ apiKey, baseURL: baseURL(), maxRetries: 2, timeout: 10 * 60 * 1000 })
}

/**
 * Request options per model and thinking level. Opus 5.5, Sonnet 5.5 and Fable 5.2 get server-side
 * fallbacks, so a safety-classifier decline is retried on a suitable model in the same call. Haiku
 * has none. Thinking is adaptive with a readable summary (shown in the panel); "off" stops it where
 * the model allows (Sonnet 5.5: between tool calls only; Haiku 5.5: disabled), at a low effort.
 */
export function modelParams(model: string, level: Effort) {
  const fallback = model !== 'claude-haiku-5-5'
  const effort = claudeEffort(model, level)
  const off = effort === 'off'
  const thinking = off
    ? model === 'claude-sonnet-5-5'
      ? ({ type: 'between_tools' } as unknown as Anthropic.Beta.BetaThinkingConfigParam)
      : ({ type: 'disabled' } as const)
    : ({ type: 'adaptive', display: 'summarized' } as const)
  return {
    model,
    output_config: { effort: (off ? 'low' : effort) as 'low' | 'medium' | 'high' },
    thinking,
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const } : {})
  }
}

/** Plain-language errors for the person. */
export function explainError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was not accepted. Check it in Settings → Assistant.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key may not use that model. Pick another model in Settings → Assistant.'
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate-limiting this key right now. Try again in a minute.'
  if (err instanceof Anthropic.APIConnectionError) return 'Can’t reach Anthropic. Check your internet connection.'
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`
  if (err instanceof Anthropic.APIError) return `Anthropic returned an error (${err.status ?? '?'}). Try again.`
  if (err instanceof AppError) return err.message
  return 'Something went wrong talking to Claude.'
}

/** What went wrong with a call to Anthropic, as a kind with the status and the short message. */
export function claudeFailure(err: unknown): ErrorDetails {
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'network', status: 0, message: '' }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    const kind: ProviderFailureKind =
      status === 401 || status === 403 ? 'auth' : status === 404 ? 'model_not_found' : status === 429 ? 'rate_limit' : status === 400 || status === 422 ? 'bad_request' : status >= 500 ? 'server' : 'unknown'
    return { kind, status, message: kind === 'bad_request' ? err.message.slice(0, 300) : '' }
  }
  return { kind: 'unknown', status: 0, message: '' }
}

export async function checkKey(apiKey: string): Promise<void> {
  try {
    await new Anthropic({ apiKey, baseURL: baseURL(), maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 })
  } catch (err) {
    throw new AppError('assistant.bad_key', explainError(err))
  }
}
