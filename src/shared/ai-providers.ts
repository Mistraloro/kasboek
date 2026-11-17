/**
 * AI providers for the in-app assistant. Claude uses Anthropic's own API; the others use the
 * OpenAI-compatible Chat Completions format, which they all offer. Local providers (Ollama,
 * LM Studio) run on the person's own computer or network.
 */
export const PROVIDER_IDS = ['anthropic', 'mistral', 'groq', 'deepseek', 'ollama', 'lmstudio', 'openrouter', 'together', 'fireworks', 'gemini'] as const
export type BuiltinProviderId = (typeof PROVIDER_IDS)[number]
/** An OpenAI-compatible server the person added: any number of them. "custom" is the single one older versions had. */
export type CustomProviderId = 'custom' | `custom-${string}`
export type ProviderId = BuiltinProviderId | CustomProviderId

export const isCustomId = (id: string): id is CustomProviderId => id === 'custom' || id.startsWith('custom-')
export const isProviderId = (id: unknown): id is ProviderId =>
  typeof id === 'string' && ((PROVIDER_IDS as readonly string[]).includes(id) || /^custom(-[a-z0-9]{1,40})?$/.test(id))

/** What is remembered per provider while another one is in use (the key is a secret of its own). */
export interface ProviderSettings {
  /** Custom providers only: the name in the provider list. */
  name?: string
  baseUrl?: string | null
  chatModel?: string
  csvModel?: string
}

export interface ProviderPreset {
  id: ProviderId
  /** In the provider list. */
  name: string
  /** What the assistant is called in the app ("Ask Mistral…"). */
  assistantName: string
  /** Who receives the data (for the privacy note). Null for providers on the person's own machine. */
  company: string | null
  baseUrl: string
  /** The base URL may be changed (local servers on another port or computer, or a custom server). */
  editableUrl: boolean
  needsKey: boolean
  keyUrl?: string
  keyPlaceholder?: string
  /** Starting points; the full list can be loaded from the provider. */
  suggestedModels: string[]
}

export const PROVIDERS: Record<BuiltinProviderId, ProviderPreset> = {
  anthropic: { id: 'anthropic', name: 'Claude', assistantName: 'Claude', company: 'Anthropic', baseUrl: 'https://api.anthropic.com', editableUrl: false, needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…', suggestedModels: [] },
  mistral: { id: 'mistral', name: 'Mistral', assistantName: 'Mistral', company: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', editableUrl: false, needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', suggestedModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'] },
  groq: { id: 'groq', name: 'Groq', assistantName: 'Groq', company: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', editableUrl: false, needsKey: true, keyUrl: 'https://console.groq.com/keys', keyPlaceholder: 'gsk_…', suggestedModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'] },
  deepseek: { id: 'deepseek', name: 'DeepSeek', assistantName: 'DeepSeek', company: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', editableUrl: false, needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: 'sk-…', suggestedModels: ['deepseek-chat', 'deepseek-reasoner'] },
  ollama: { id: 'ollama', name: 'Ollama', assistantName: 'Ollama', company: null, baseUrl: 'http://localhost:11434/v1', editableUrl: true, needsKey: false, suggestedModels: [] },
  lmstudio: { id: 'lmstudio', name: 'LM Studio', assistantName: 'LM Studio', company: null, baseUrl: 'http://localhost:1234/v1', editableUrl: true, needsKey: false, suggestedModels: [] },
  openrouter: { id: 'openrouter', name: 'OpenRouter', assistantName: 'OpenRouter', company: 'OpenRouter and the model’s provider', baseUrl: 'https://openrouter.ai/api/v1', editableUrl: false, needsKey: true, keyUrl: 'https://openrouter.ai/settings/keys', keyPlaceholder: 'sk-or-…', suggestedModels: ['openrouter/auto'] },
  together: { id: 'together', name: 'Together AI', assistantName: 'Together AI', company: 'Together AI', baseUrl: 'https://api.together.xyz/v1', editableUrl: false, needsKey: true, keyUrl: 'https://api.together.ai/settings/api-keys', suggestedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'] },
  fireworks: { id: 'fireworks', name: 'Fireworks AI', assistantName: 'Fireworks AI', company: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', editableUrl: false, needsKey: true, keyUrl: 'https://fireworks.ai/account/api-keys', keyPlaceholder: 'fw_…', suggestedModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct'] },
  gemini: { id: 'gemini', name: 'Gemini', assistantName: 'Gemini', company: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', editableUrl: false, needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'] }
}

export const CUSTOM_PRESET: ProviderPreset = { id: 'custom', name: 'Other (OpenAI-compatible)', assistantName: 'Assistant', company: 'the server you entered', baseUrl: '', editableUrl: true, needsKey: false, suggestedModels: [] }

/** The preset of a provider; a custom one carries the name the person gave it. An unknown id is Claude. */
export function presetFor(id: ProviderId, name?: string): ProviderPreset {
  if (isCustomId(id)) return { ...CUSTOM_PRESET, id, name: name || CUSTOM_PRESET.name }
  return PROVIDERS[id] ?? PROVIDERS.anthropic
}

/** Loopback and private network addresses, where plain http is acceptable. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * Whether calls to this address need an API key. Providers that always do say so in their preset; a custom
 * one needs a key unless it is on this computer or the local network (a keyless local server is legitimate).
 */
export function keyRequired(preset: ProviderPreset, baseUrl: string): boolean {
  if (!isCustomId(preset.id)) return preset.needsKey
  try {
    return !isLocalHost(new URL(baseUrl).hostname)
  } catch {
    return true
  }
}

/** Checks a base URL: https, or http only on this computer or the local network (keys must not travel in the clear). */
export function checkBaseUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'Enter a full address, like https://api.example.com/v1.'
  }
  if (u.username || u.password) return 'Put the key in the key field, not in the address.'
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return null
  if (u.protocol === 'http:') return 'Use https for servers outside this computer or your local network.'
  return 'Use an http or https address.'
}
