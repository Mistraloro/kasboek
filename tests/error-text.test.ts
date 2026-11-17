import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { describe, expect, it, vi } from 'vitest'
import { ProviderError, providerFailure, providerError, ToolArgumentsError } from '../src/main/assistant/openai'
import { PROVIDER_FAILURE_KINDS, errorKey, errorVars, type ErrorDetails } from '@shared/error-text'
import { FALLBACKS, LANGUAGE_CODES } from '@shared/languages'
import { AppError } from '@core/errors'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, app: { isPackaged: false } }))

const dir = join(process.cwd(), 'src/renderer/src/i18n/locales')
const resources = Object.fromEntries(LANGUAGE_CODES.map((c) => [c, { translation: JSON.parse(readFileSync(join(dir, `${c}.json`), 'utf8')) as Record<string, unknown> }]))
const errorKeys = Object.keys((resources['en']!.translation as { errors: Record<string, string> }).errors)

describe('which values an error text needs', () => {
  it('uses the provider in use, and the assistant when none is set', () => {
    expect(errorVars({ name: 'Mistral', company: 'Mistral AI' }, 'the assistant')).toEqual({ ai: 'Mistral', aiCompany: 'Mistral AI', status: '', detail: '' })
    expect(errorVars({ name: 'Ollama', company: null }, 'the assistant')).toMatchObject({ ai: 'Ollama', aiCompany: 'Ollama' })
    expect(errorVars(null, 'the assistant')).toMatchObject({ ai: 'the assistant', aiCompany: 'the assistant' })
  })

  it('shows the provider’s own message in brackets and the status', () => {
    const details: ErrorDetails = { kind: 'server', status: 503, message: 'overloaded' }
    expect(errorVars(null, 'x', details)).toMatchObject({ status: '503', detail: ' (overloaded)' })
    expect(errorVars(null, 'x', { ...details, message: '' }).detail).toBe('')
  })

  it('picks a text per kind for failures of the provider, else by code', () => {
    expect(errorKey('assistant.failed', { kind: 'rate_limit', status: 429, message: '' })).toBe('errors.assistant_failed_rate_limit')
    expect(errorKey('assistant.failed')).toBe('errors.assistant_failed')
    expect(errorKey('assistant.refused')).toBe('errors.assistant_refused')
  })

  it.each(LANGUAGE_CODES)('leaves no placeholder in any error text in %s', async (code) => {
    const i18n = i18next.createInstance()
    await i18n.init({ resources, lng: code, fallbackLng: { ...FALLBACKS, default: ['en'] }, interpolation: { escapeValue: false } })
    for (const withProvider of [true, false]) {
      const vars = errorVars(withProvider ? { name: 'Mistral', company: 'Mistral AI' } : null, i18n.t('ai.neutralName'), { kind: 'server', status: 500, message: 'boom' })
      for (const key of errorKeys) expect(i18n.t(`errors.${key}`, vars), `${code} errors.${key}`).not.toContain('{{')
    }
  })

  it('has a text for every kind of provider failure in every language that is complete', () => {
    for (const code of LANGUAGE_CODES.filter((c) => c !== 'es-419' && c !== 'pt-BR'))
      for (const kind of PROVIDER_FAILURE_KINDS) expect((resources[code]!.translation as { errors: Record<string, string> }).errors[`assistant_failed_${kind}`], `${code} ${kind}`).toBeTruthy()
  })
})

describe('what went wrong with the provider', () => {
  it.each([
    [0, 'network'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_not_found'],
    [429, 'rate_limit'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [500, 'server'],
    [503, 'server'],
    [418, 'unknown']
  ])('status %i is %s, with the provider’s own message', (status, kind) => {
    expect(providerFailure(new ProviderError(status, 'short note'))).toEqual({ kind, status, message: 'short note' })
  })

  it('is unknown for anything else', () => {
    expect(providerFailure(new TypeError('x'))).toEqual({ kind: 'unknown', status: 0, message: '' })
    expect(providerFailure(new ToolArgumentsError('unreadable'))).toMatchObject({ kind: 'unknown', message: 'unreadable' })
  })

  it('becomes assistant.failed with the details, and leaves other app errors alone', () => {
    const err = providerError(new ProviderError(429, 'slow down'), 'Mistral')
    expect(err).toMatchObject({ code: 'assistant.failed', details: { kind: 'rate_limit', status: 429, message: 'slow down' } })
    const other = new AppError('assistant.timeout', 'late')
    expect(providerError(other, 'Mistral')).toBe(other)
  })
})
