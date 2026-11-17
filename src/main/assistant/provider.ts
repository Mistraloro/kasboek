/** Which AI provider is in use, where its key lives, and the address to call. */
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret } from '@core/secrets'
import { getSettings } from '@core/settings'
import { checkBaseUrl, type ProviderId } from '@shared/ai-providers'
import { resolveProvider, type ResolvedProvider } from '@shared/ai-provider-store'
import { API_KEY } from './claude'

/** Secret name for a provider's API key (Claude keeps its original name). */
export const keyName = (id: ProviderId): string => (id === 'anthropic' ? API_KEY : `aiKey.${id}`)

export interface ActiveProvider extends ResolvedProvider {
  key: string | null
}

export function activeProvider(db: Db): ActiveProvider {
  const p = resolveProvider(getSettings(db))
  return { ...p, key: getSecret(db, keyName(p.preset.id)) }
}

/** True when the assistant has what it needs to answer (key and, for OpenAI-compatible, a model). */
export function isConfigured(p: ActiveProvider): boolean {
  if (p.preset.id === 'anthropic') return !!p.key
  if (p.preset.needsKey && !p.key) return false
  return !!p.chatModel && !!p.baseUrl && !checkBaseUrl(p.baseUrl)
}

export function requireConfigured(p: ActiveProvider): void {
  if (p.preset.id === 'anthropic') {
    if (!p.key) throw new AppError('assistant.no_key', 'Add your Anthropic API key in Settings → Assistant first.')
    return
  }
  if (p.preset.needsKey && !p.key) throw new AppError('assistant.no_key', `Add your ${p.preset.name} API key in Settings → Assistant first.`)
  const bad = checkBaseUrl(p.baseUrl)
  if (bad) throw new AppError('assistant.bad_url', bad)
  if (!p.chatModel) throw new AppError('assistant.no_model', `Choose a ${p.preset.name} model in Settings → Assistant first.`)
}
