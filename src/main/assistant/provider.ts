/** Which AI provider is in use, where its key lives, and the address to call. */
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret } from '@core/secrets'
import { getSettings } from '@core/settings'
import { PROVIDERS, checkBaseUrl, type ProviderId, type ProviderPreset } from '@shared/ai-providers'
import { API_KEY } from './claude'

/** Secret name for a provider's API key (Claude keeps its original name). */
export const keyName = (id: ProviderId): string => (id === 'anthropic' ? API_KEY : `aiKey.${id}`)

export interface ActiveProvider {
  preset: ProviderPreset
  baseUrl: string
  key: string | null
  chatModel: string
  csvModel: string
}

export function activeProvider(db: Db): ActiveProvider {
  const s = getSettings(db)
  const preset = PROVIDERS[s.aiProvider] ?? PROVIDERS.anthropic
  const baseUrl = (preset.editableUrl && s.aiBaseUrl) || preset.baseUrl
  return { preset, baseUrl, key: getSecret(db, keyName(preset.id)), chatModel: s.aiChatModel, csvModel: s.aiCsvModel || s.aiChatModel }
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
