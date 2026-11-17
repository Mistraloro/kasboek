/**
 * One model call that must answer with JSON matching a schema, no tools. Used by the CSV check and
 * the PDF read. Claude gets the schema as its output format; the OpenAI-compatible providers get it
 * as a strict JSON schema, or plain JSON mode with the schema in the prompt where that is refused.
 */
import { z } from 'zod'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSettings } from '@core/settings'
import { reasoningParams } from '@shared/reasoning'
import { client, explainError, modelParams } from './claude'
import * as openai from './openai'
import type { ActiveProvider } from './provider'

/** The longest answer asked for. */
const MAX_TOKENS = 32000

/** The model's answer as JSON text, from the model chosen for CSV checks. */
export async function callJson(
  db: Db,
  provider: ActiveProvider,
  opts: { system: string; schema: z.ZodType; context: string; signal: AbortSignal; onThinking?: (t: string) => void }
): Promise<string> {
  const name = provider.preset.assistantName
  const { system, schema, context, signal, onThinking } = opts
  if (provider.preset.id !== 'anthropic') {
    try {
      return await openai.json(provider, { system, user: context, schema: z.toJSONSchema(schema) as Record<string, unknown>, maxTokens: MAX_TOKENS, signal, onThinking, reasoning: reasoningParams(provider.preset.id, getSettings(db).aiCsvReasoning) })
    } catch (err) {
      if (signal.aborted) throw err
      throw err instanceof AppError ? err : new AppError('assistant.failed', openai.explainProviderError(err, name))
    }
  }
  const settings = getSettings(db)
  const params = modelParams(settings.csvModel, settings.csvEffort)
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
    if (message.stop_reason === 'refusal') throw new AppError('assistant.refused', `${name} declined to check this file.`)
    if (message.stop_reason === 'max_tokens') throw new AppError('assistant.too_long', 'This part of the file was too large for one answer. Try again, or a shorter export.')
    for (const b of message.content) if (b.type === 'text') text += b.text
  } catch (err) {
    if (signal.aborted) throw err
    throw err instanceof AppError ? err : new AppError('assistant.failed', explainError(err))
  }
  return text
}
