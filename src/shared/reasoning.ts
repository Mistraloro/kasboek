/**
 * How much the assistant thinks before answering. Claude models each allow their own levels
 * (some can't stop thinking at all); other providers get a general level that Kasboek translates
 * into that provider's own parameter.
 */
import type { AssistantModel } from './types'

/** Claude's levels: "off" (no thinking) only where the model allows it. */
export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** Levels per Claude model: Opus 5.5 and Fable 5.2 always think. */
export function claudeEfforts(model: AssistantModel): Effort[] {
  const canStop = model === 'claude-sonnet-5-5' || model === 'claude-haiku-5-5'
  return canStop ? [...EFFORTS] : EFFORTS.filter((e) => e !== 'off')
}

/** The chosen level, or the nearest one this model has. */
export function claudeEffort(model: AssistantModel, effort: Effort): Effort {
  return claudeEfforts(model).includes(effort) ? effort : 'low'
}

/** For other providers: "default" sends nothing and leaves it to the model. */
export const REASONING_LEVELS = ['default', 'off', 'low', 'medium', 'high'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * The request fields for a reasoning level, per provider (OpenAI-compatible Chat Completions).
 * Models that don't take them are handled by the caller: it retries without these fields.
 */
export function reasoningParams(provider: string, level: ReasoningLevel): Record<string, unknown> {
  if (level === 'default') return {}
  switch (provider) {
    // DeepSeek: a separate switch to turn thinking off; two levels when on.
    case 'deepseek':
      return level === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level === 'low' ? 'low' : 'high' }
    // OpenRouter: its own reasoning object, passed on to the model's provider.
    case 'openrouter':
      return { reasoning: { effort: level === 'off' ? 'none' : level } }
    // Mistral, Groq, Gemini, Ollama, LM Studio and other OpenAI-compatible servers.
    default:
      return { reasoning_effort: level === 'off' ? 'none' : level }
  }
}
