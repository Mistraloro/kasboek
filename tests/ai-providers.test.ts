import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { setPasswordKdfForTests } from '@core/crypto'
import { openDatabase } from '@core/database'
import { getSecret, setSecret } from '@core/secrets'
import { DEFAULT_SETTINGS, getSettings, resetImportedSettings, updateSettings } from '@core/settings'
import { contract } from '@shared/contract'
import { checkBaseUrl, isProviderId, type ProviderId } from '@shared/ai-providers'
import { addCustomProvider, customProviders, isKnownProvider, newCustomId, providerGap, removeCustomProvider, renameCustomProvider, resolveProvider, switchProvider } from '@shared/ai-provider-store'
import type { Settings } from '@shared/types'
import { activeProvider, isConfigured, keyName, requireConfigured } from '../src/main/assistant/provider'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))

const openDb = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-ai-')), 'k.db'), randomBytes(32).toString('hex'))

/** Applies a patch the way the settings are stored: the patched keys replace the old ones. */
const apply = (s: Settings, patch: Partial<Settings>): Settings => ({ ...s, ...patch })

const cloud = { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', chatModel: 'gpt-oss:120b', csvModel: '' }
const home = { name: 'Home server', baseUrl: 'http://192.168.1.20:8080/v1', chatModel: 'qwen3', csvModel: 'qwen3-small' }

describe('remembering settings per provider', () => {
  it('restores the address and models of a provider when switching back to it', () => {
    let s = apply(DEFAULT_SETTINGS, { aiProvider: 'ollama', aiBaseUrl: 'http://10.0.0.5:11434/v1', aiChatModel: 'llama3', aiCsvModel: 'llama3-small' })
    s = apply(s, switchProvider(s, 'mistral'))
    expect(s.aiChatModel).toBe('mistral-large-latest')
    s = apply(s, { aiChatModel: 'mistral-small-latest' })
    s = apply(s, switchProvider(s, 'ollama'))
    expect(resolveProvider(s)).toMatchObject({ baseUrl: 'http://10.0.0.5:11434/v1', chatModel: 'llama3', csvModel: 'llama3-small' })
    s = apply(s, switchProvider(s, 'mistral'))
    expect(s.aiChatModel).toBe('mistral-small-latest')
  })

  it('keeps two custom providers apart, each with its own address and models', () => {
    let s = apply(DEFAULT_SETTINGS, addCustomProvider(DEFAULT_SETTINGS, 'custom-aaa', cloud))
    s = apply(s, addCustomProvider(s, 'custom-bbb', home))
    expect(resolveProvider(s)).toMatchObject({ baseUrl: home.baseUrl, chatModel: 'qwen3', csvModel: 'qwen3-small' })
    expect(resolveProvider(s, 'custom-aaa')).toMatchObject({ baseUrl: cloud.baseUrl, chatModel: 'gpt-oss:120b', csvModel: 'gpt-oss:120b' })
    s = apply(s, switchProvider(s, 'custom-aaa'))
    expect(s.aiBaseUrl).toBe(cloud.baseUrl)
    expect(resolveProvider(s, 'custom-bbb').baseUrl).toBe(home.baseUrl)
    expect(customProviders(s).map((p) => p.name)).toEqual(['Ollama Cloud', 'Home server'])
    expect(keyName('custom-aaa')).not.toBe(keyName('custom-bbb'))
  })

  it('removes one custom provider and leaves the other; removing the one in use hands over to Claude', () => {
    let s = apply(DEFAULT_SETTINGS, addCustomProvider(DEFAULT_SETTINGS, 'custom-aaa', cloud))
    s = apply(s, addCustomProvider(s, 'custom-bbb', home))
    s = apply(s, removeCustomProvider(s, 'custom-bbb'))
    expect(s.aiProvider).toBe('anthropic')
    expect(customProviders(s).map((p) => p.id)).toEqual(['custom-aaa'])
    expect(isKnownProvider(s, 'custom-bbb')).toBe(false)
    expect(resolveProvider(s, 'custom-aaa').baseUrl).toBe(cloud.baseUrl)
    s = apply(s, removeCustomProvider(s, 'custom-aaa'))
    expect(customProviders(s)).toEqual([])
  })

  it('renames a custom provider without touching its values', () => {
    let s = apply(DEFAULT_SETTINGS, addCustomProvider(DEFAULT_SETTINGS, 'custom-aaa', cloud))
    s = apply(s, renameCustomProvider(s, 'custom-aaa', 'Cloud'))
    expect(customProviders(s)).toEqual([{ id: 'custom-aaa', name: 'Cloud' }])
    expect(s.aiBaseUrl).toBe(cloud.baseUrl)
    s = apply(s, switchProvider(s, 'mistral'))
    expect(customProviders(s)[0]?.name).toBe('Cloud')
  })

  it('treats flat settings of an older version as they are: the old single "custom" provider keeps its values and key', () => {
    const old = apply(DEFAULT_SETTINGS, { aiProvider: 'custom', aiBaseUrl: 'https://ollama.com/v1', aiChatModel: 'gpt-oss:120b' })
    expect(old.aiProviders).toEqual({})
    expect(customProviders(old)).toEqual([{ id: 'custom', name: 'Other (OpenAI-compatible)' }])
    expect(keyName('custom')).toBe('aiKey.custom')
    // Switching away and back loses nothing.
    let s = apply(old, switchProvider(old, 'mistral'))
    expect(customProviders(s).map((p) => p.id)).toEqual(['custom'])
    s = apply(s, switchProvider(s, 'custom'))
    expect(resolveProvider(s)).toMatchObject({ baseUrl: 'https://ollama.com/v1', chatModel: 'gpt-oss:120b' })
  })

  it('makes ids that pass validation', () => {
    const id = newCustomId('3f2a9c1e-77b4-4d0a-9a4e-0c1d2e3f4a5b')
    expect(id).toMatch(/^custom-[a-z0-9]+$/)
    expect(isProviderId(id)).toBe(true)
    expect(isProviderId('custom-')).toBe(false)
    expect(isProviderId('custom-../x')).toBe(false)
    expect(isProviderId('nope')).toBe(false)
  })
})

describe('readiness', () => {
  const ready = (s: Settings, key: string | null, id: ProviderId = s.aiProvider) => providerGap(resolveProvider(s, id), key)
  const custom = (init: typeof cloud) => apply(DEFAULT_SETTINGS, addCustomProvider(DEFAULT_SETTINGS, 'custom-aaa', init))

  it('is ready for a custom provider with address, key and model', () => {
    expect(ready(custom(cloud), 'sk-123456789')).toBeNull()
  })
  it('is ready for a custom server on this computer or network without a key', () => {
    expect(ready(custom(home), null)).toBeNull()
    expect(ready(custom({ ...home, baseUrl: 'http://localhost:11434/v1' }), null)).toBeNull()
  })
  it('wants a key for a custom server elsewhere', () => {
    expect(ready(custom(cloud), null)).toBe('key')
  })
  it('is not ready without a model or with a bad address', () => {
    expect(ready(custom({ ...cloud, chatModel: '' }), 'sk-123456789')).toBe('model')
    expect(ready(custom({ ...home, chatModel: '' }), null)).toBe('model')
    expect(ready(custom({ ...cloud, baseUrl: '' }), 'sk-123456789')).toBe('url')
    expect(ready(custom({ ...home, baseUrl: '' }), 'sk-123456789')).toBe('url')
    expect(ready(custom({ ...cloud, baseUrl: 'http://example.com/v1' }), 'sk-123456789')).toBe('url')
  })
  it('keeps the rules of the built-in providers', () => {
    expect(ready(DEFAULT_SETTINGS, null)).toBe('key')
    expect(ready(DEFAULT_SETTINGS, 'sk-ant-x')).toBeNull()
    expect(ready(apply(DEFAULT_SETTINGS, { aiProvider: 'mistral', aiChatModel: 'mistral-large-latest' }), null)).toBe('key')
    expect(ready(apply(DEFAULT_SETTINGS, { aiProvider: 'ollama', aiChatModel: 'llama3' }), null)).toBeNull()
  })
})

describe('address validation', () => {
  it('applies to every custom provider through the contract', () => {
    const add = contract['assistant.addProvider'].input
    expect(add.safeParse(cloud).success).toBe(true)
    expect(add.safeParse(home).success).toBe(true)
    expect(add.safeParse({ ...cloud, baseUrl: 'http://example.com/v1' }).success).toBe(false)
    expect(add.safeParse({ ...cloud, baseUrl: 'https://user:pw@ollama.com/v1' }).success).toBe(false)
    expect(add.safeParse({ ...cloud, baseUrl: 'ollama.com' }).success).toBe(false)
    expect(add.safeParse({ ...cloud, name: ' ' }).success).toBe(false)
    expect(checkBaseUrl('https://ollama.com/v1')).toBeNull()
  })
  it('accepts a custom id in configure and setKey, and nothing unknown', () => {
    expect(contract['assistant.configure'].input.safeParse({ aiProvider: 'custom-abc123' }).success).toBe(true)
    expect(contract['assistant.configure'].input.safeParse({ aiProvider: 'bogus' }).success).toBe(false)
    expect(contract['assistant.setKey'].input.safeParse({ apiKey: 'abcdefghij', provider: 'custom-abc123' }).success).toBe(true)
  })
})

describe('with a database', () => {
  it('resolves a custom id to its own key, address and models', () => {
    const d = openDb()
    updateSettings(d, addCustomProvider(getSettings(d), 'custom-aaa', cloud))
    setSecret(d, keyName('custom-aaa'), 'sk-cloud-0001')
    updateSettings(d, addCustomProvider(getSettings(d), 'custom-bbb', home))
    setSecret(d, keyName('custom-bbb'), 'sk-home-0002')
    let p = activeProvider(d)
    expect(p).toMatchObject({ baseUrl: home.baseUrl, chatModel: 'qwen3', key: 'sk-home-0002' })
    updateSettings(d, switchProvider(getSettings(d), 'custom-aaa'))
    p = activeProvider(d)
    expect(p).toMatchObject({ baseUrl: cloud.baseUrl, chatModel: 'gpt-oss:120b', csvModel: 'gpt-oss:120b', key: 'sk-cloud-0001' })
    expect(p.preset.name).toBe('Ollama Cloud')
    expect(isConfigured(p)).toBe(true)
    expect(() => requireConfigured(p)).not.toThrow()
    expect(() => requireConfigured({ ...p, key: null })).toThrow(/API key/)
    expect(() => requireConfigured({ ...p, chatModel: '' })).toThrow(/model/)
  })

  it('forgets the key of a removed provider only by name, leaving the other key', () => {
    const d = openDb()
    updateSettings(d, addCustomProvider(getSettings(d), 'custom-aaa', cloud))
    setSecret(d, keyName('custom-aaa'), 'sk-cloud-0001')
    updateSettings(d, addCustomProvider(getSettings(d), 'custom-bbb', home))
    setSecret(d, keyName('custom-bbb'), 'sk-home-0002')
    updateSettings(d, removeCustomProvider(getSettings(d), 'custom-bbb'))
    setSecret(d, keyName('custom-bbb'), null)
    expect(getSecret(d, keyName('custom-bbb'))).toBeNull()
    expect(getSecret(d, keyName('custom-aaa'))).toBe('sk-cloud-0001')
    expect(resolveProvider(getSettings(d), 'custom-aaa').baseUrl).toBe(cloud.baseUrl)
  })

  it('resets the remembered providers and their keys after an import, and nothing else', () => {
    const d = openDb()
    updateSettings(d, { ...addCustomProvider(getSettings(d), 'custom-aaa', cloud), currency: 'USD' })
    setSecret(d, keyName('custom-aaa'), 'sk-cloud-0001')
    const reset = resetImportedSettings(d)
    expect(reset).toEqual(['aiKey', 'aiEndpoint'])
    const s = getSettings(d)
    expect(s.aiProviders).toEqual({})
    expect(s.aiProvider).toBe('anthropic')
    expect(s.currency).toBe('USD')
    expect(getSecret(d, keyName('custom-aaa'))).toBeNull()
    expect(resetImportedSettings(d)).toEqual([])
  })

  it('resets a file that only carries remembered providers', () => {
    const d = openDb()
    updateSettings(d, { aiProviders: { 'custom-x': { name: 'Evil', baseUrl: 'https://evil.example/v1' } } })
    expect(resetImportedSettings(d)).toEqual(['aiEndpoint'])
    expect(getSettings(d).aiProviders).toEqual({})
  })
})

describe('the model for reading PDF statements', () => {
  it('is Haiku for Claude, the file-reading model for the others, and the chosen one when there is one', () => {
    expect(resolveProvider(DEFAULT_SETTINGS).pdfModel).toBe('claude-haiku-5-5')
    // The CSV check keeps its own model, whatever the PDF read uses.
    expect(resolveProvider(DEFAULT_SETTINGS).csvModel).toBe('')
    expect(resolveProvider(apply(DEFAULT_SETTINGS, { aiPdfModel: 'claude-sonnet-5-5' })).pdfModel).toBe('claude-sonnet-5-5')

    const ollama = apply(DEFAULT_SETTINGS, { aiProvider: 'ollama', aiChatModel: 'llama3' })
    expect(resolveProvider(ollama)).toMatchObject({ csvModel: 'llama3', pdfModel: 'llama3' })
    expect(resolveProvider(apply(ollama, { aiCsvModel: 'llama3-small' })).pdfModel).toBe('llama3-small')
    expect(resolveProvider(apply(ollama, { aiCsvModel: 'llama3-small', aiPdfModel: 'llama3-tiny' }))).toMatchObject({ csvModel: 'llama3-small', pdfModel: 'llama3-tiny' })

    const custom = apply(DEFAULT_SETTINGS, addCustomProvider(DEFAULT_SETTINGS, 'custom-aaa', home))
    expect(resolveProvider(custom).pdfModel).toBe('qwen3-small')
    expect(resolveProvider(apply(custom, { aiCsvModel: '' })).pdfModel).toBe('qwen3')
  })

  it('is remembered per provider, like the other two models', () => {
    let s = apply(DEFAULT_SETTINGS, { aiPdfModel: 'claude-sonnet-5-5' })
    s = apply(s, switchProvider(s, 'ollama'))
    expect(s.aiPdfModel).toBe('')
    s = apply(s, { aiChatModel: 'llama3', aiPdfModel: 'llama3-tiny' })
    s = apply(s, switchProvider(s, 'anthropic'))
    expect(s.aiPdfModel).toBe('claude-sonnet-5-5')
    expect(resolveProvider(s, 'ollama').pdfModel).toBe('llama3-tiny')
    s = apply(s, switchProvider(s, 'ollama'))
    expect(s.aiPdfModel).toBe('llama3-tiny')
    expect(resolveProvider(s, 'anthropic').pdfModel).toBe('claude-sonnet-5-5')
  })

  it('does not change when a provider is ready', () => {
    const ollama = apply(DEFAULT_SETTINGS, { aiProvider: 'ollama', aiChatModel: 'llama3' })
    expect(providerGap(resolveProvider(ollama), null)).toBeNull()
    expect(providerGap(resolveProvider(apply(ollama, { aiPdfModel: 'x' })), null)).toBeNull()
    expect(providerGap(resolveProvider(apply(ollama, { aiChatModel: '', aiPdfModel: 'x' })), null)).toBe('model')
    expect(providerGap(resolveProvider(DEFAULT_SETTINGS), null)).toBe('key')
    expect(providerGap(resolveProvider(DEFAULT_SETTINGS), 'sk-ant-key')).toBeNull()
  })

  it('is part of the settings contract and gone after an import', () => {
    expect(contract['assistant.configure'].input.safeParse({ aiPdfModel: ' llama3-tiny ' })).toMatchObject({ success: true, data: { aiPdfModel: 'llama3-tiny' } })
    const d = openDb()
    updateSettings(d, { aiPdfModel: 'claude-sonnet-5-5', ...switchProvider({ ...getSettings(d), aiPdfModel: 'claude-sonnet-5-5' }, 'ollama') })
    expect(getSettings(d).aiProviders['anthropic']?.pdfModel).toBe('claude-sonnet-5-5')
    resetImportedSettings(d)
    expect(getSettings(d).aiProviders).toEqual({})
    expect(resolveProvider(getSettings(d), 'anthropic').pdfModel).toBe('claude-haiku-5-5')
  })
})
