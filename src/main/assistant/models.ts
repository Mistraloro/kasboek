/** Checking a key and listing models, for any provider. */
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { ASSISTANT_MODELS } from '@shared/types'
import { explainProviderError, listModels } from './openai'
import { activeProvider, type ActiveProvider } from './provider'

export async function checkProviderKey(p: ActiveProvider): Promise<void> {
  try {
    await listModels(p)
  } catch (err) {
    throw new AppError('assistant.bad_key', explainProviderError(err, p.preset.name))
  }
}

export async function listProviderModels(db: Db): Promise<string[]> {
  const p = activeProvider(db)
  if (p.preset.id === 'anthropic') return [...ASSISTANT_MODELS]
  try {
    return await listModels(p)
  } catch (err) {
    throw new AppError('assistant.models', explainProviderError(err, p.preset.name))
  }
}

