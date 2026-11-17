/** Which AI provider is in use, where its key lives, and the address to call. */
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { getSecret } from '@core/secrets'
import { getSettings } from '@core/settings'
import { checkBaseUrl, type ProviderId } from '@shared/ai-providers'
import { providerGap, resolveProvider, type ResolvedProvider } from '@shared/ai-provider-store'
import { API_KEY } from './claude'

/** Roughly how many characters a token is, for the estimate shown before anything is sent. */
export const CHARS_PER_TOKEN = 3

/** Secret name for a provider's API key (Claude keeps its original name). */
export const keyName = (id: ProviderId): string => (id === 'anthropic' ? API_KEY : `aiKey.${id}`)

export interface ActiveProvider extends ResolvedProvider {
  key: string | null
}

export function activeProvider(db: Db): ActiveProvider {
  const p = resolveProvider(getSettings(db))
  return { ...p, key: getSecret(db, keyName(p.preset.id)) }
}

/**
 * Where requests go, as shown in the dialogs where the person agrees: only the host of an online
 * provider (its address is fixed), the whole address of one the person can point anywhere (local
 * servers, custom ones), so that a changed address is visible.
 */
export function shownAddress(p: ActiveProvider): string {
  if (p.preset.editableUrl) return p.baseUrl
  try {
    return new URL(p.baseUrl).host
  } catch {
    return p.baseUrl
  }
}

/** True when the assistant has what it needs to answer. */
export function isConfigured(p: ActiveProvider): boolean {
  return providerGap(p, p.key) === null
}

export function requireConfigured(p: ActiveProvider): void {
  const gap = providerGap(p, p.key)
  if (gap === 'key') throw new AppError('assistant.no_key', `Add your ${p.preset.id === 'anthropic' ? 'Anthropic' : p.preset.name} API key in Settings → Assistant first.`)
  if (gap === 'url') throw new AppError('assistant.bad_url', checkBaseUrl(p.baseUrl) ?? `Enter the address of ${p.preset.name} in Settings → Assistant first.`)
  if (gap === 'model') throw new AppError('assistant.no_model', `Choose a ${p.preset.name} model in Settings → Assistant first.`)
}
