/**
 * What is remembered per AI provider. The flat settings (aiProvider, aiBaseUrl, aiChatModel, aiCsvModel)
 * are the values of the provider in use; every other provider's values wait in aiProviders until it is
 * chosen again. Switching saves the old values and restores the new ones, so nothing typed is lost.
 * Settings from before this existed need no migration step: the flat values already are the values of the
 * provider in use (the single "custom" provider of older versions included, which keeps its key as
 * aiKey.custom), and they are saved the first time the person switches away.
 */
import { CUSTOM_PRESET, checkBaseUrl, isCustomId, keyRequired, presetFor, type ProviderId, type ProviderPreset, type ProviderSettings } from './ai-providers'
import type { Settings } from './types'

export type AiSettings = Pick<Settings, 'aiProvider' | 'aiBaseUrl' | 'aiChatModel' | 'aiCsvModel' | 'aiProviders'>
export type AiPatch = Pick<Partial<Settings>, 'aiProvider' | 'aiBaseUrl' | 'aiChatModel' | 'aiCsvModel' | 'aiProviders'>

/** What a call to a provider needs, apart from its key. */
export interface ResolvedProvider {
  preset: ProviderPreset
  baseUrl: string
  chatModel: string
  csvModel: string
}

export interface CustomProvider {
  id: ProviderId
  name: string
}

/** A new random id for a custom provider. */
export const newCustomId = (random: string): ProviderId => `custom-${random.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)}`

/** The values of one provider: the flat ones when it is in use, else what was saved (or the starting values). */
function valuesOf(s: AiSettings, id: ProviderId): { baseUrl: string | null; chatModel: string; csvModel: string } {
  if (id === s.aiProvider) return { baseUrl: s.aiBaseUrl, chatModel: s.aiChatModel, csvModel: s.aiCsvModel }
  const saved = s.aiProviders[id]
  return { baseUrl: saved?.baseUrl ?? null, chatModel: saved?.chatModel ?? presetFor(id).suggestedModels[0] ?? '', csvModel: saved?.csvModel ?? '' }
}

/** The address, models and preset to call for a provider (the one in use unless another id is given). */
export function resolveProvider(s: AiSettings, id: ProviderId = s.aiProvider): ResolvedProvider {
  const preset = presetFor(id, s.aiProviders[id]?.name)
  const v = valuesOf(s, id)
  return { preset, baseUrl: (preset.editableUrl && v.baseUrl) || preset.baseUrl, chatModel: v.chatModel, csvModel: v.csvModel || v.chatModel }
}

/** What is still missing before a provider can answer; null when it is ready. Checked in this order. */
export type ProviderGap = 'key' | 'url' | 'model'

/**
 * Ready means: Claude has its key; any other provider has a valid address and a chat model, plus a key
 * unless it is a custom server on this computer or network.
 */
export function providerGap(p: ResolvedProvider, key: string | null): ProviderGap | null {
  if (p.preset.id === 'anthropic') return key ? null : 'key'
  if (keyRequired(p.preset, p.baseUrl) && !key) return 'key'
  if (!p.baseUrl || checkBaseUrl(p.baseUrl)) return 'url'
  return p.chatModel ? null : 'model'
}

/** The custom providers, in the order they were added. The one in use always counts, even when it predates this list. */
export function customProviders(s: AiSettings): CustomProvider[] {
  const ids = Object.keys(s.aiProviders).filter(isCustomId)
  if (isCustomId(s.aiProvider) && !ids.includes(s.aiProvider)) ids.push(s.aiProvider)
  return ids.map((id) => ({ id: id as ProviderId, name: s.aiProviders[id]?.name || CUSTOM_PRESET.name }))
}

/** A provider the person can choose: a built-in one or one of their custom ones. */
export const isKnownProvider = (s: AiSettings, id: ProviderId): boolean => !isCustomId(id) || customProviders(s).some((p) => p.id === id)

/** Use another provider: save the values of the one in use and restore the other's. */
export function switchProvider(s: AiSettings, to: ProviderId): AiPatch {
  const v = valuesOf(s, to)
  const leaving: ProviderSettings = { ...s.aiProviders[s.aiProvider], baseUrl: s.aiBaseUrl, chatModel: s.aiChatModel, csvModel: s.aiCsvModel }
  return { aiProvider: to, aiBaseUrl: v.baseUrl, aiChatModel: v.chatModel, aiCsvModel: v.csvModel, aiProviders: { ...s.aiProviders, [s.aiProvider]: leaving } }
}

/** Add a custom provider and use it. */
export function addCustomProvider(s: AiSettings, id: ProviderId, init: { name: string; baseUrl: string; chatModel: string; csvModel: string }): AiPatch {
  return switchProvider({ ...s, aiProviders: { ...s.aiProviders, [id]: init } }, id)
}

export function renameCustomProvider(s: AiSettings, id: ProviderId, name: string): AiPatch {
  return { aiProviders: { ...s.aiProviders, [id]: { ...s.aiProviders[id], name } } }
}

/** Forget a custom provider. When it is in use, Claude takes over again. Its key is the caller's to delete. */
export function removeCustomProvider(s: AiSettings, id: ProviderId): AiPatch {
  const patch: AiPatch = s.aiProvider === id ? switchProvider(s, 'anthropic') : {}
  const { [id]: _removed, ...rest } = patch.aiProviders ?? s.aiProviders
  return { ...patch, aiProviders: rest }
}
