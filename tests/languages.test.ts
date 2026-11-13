import { describe, expect, it } from 'vitest'
import { pickLanguage } from '@shared/languages'

describe('system language', () => {
  it('picks the closest interface language', () => {
    expect(pickLanguage(['nl-BE', 'en-US'])).toBe('nl')
    expect(pickLanguage(['fr-BE'])).toBe('fr')
    expect(pickLanguage(['es-ES'])).toBe('es')
    expect(pickLanguage(['es-MX'])).toBe('es-419')
    expect(pickLanguage(['es'])).toBe('es')
    expect(pickLanguage(['pt-BR'])).toBe('pt-BR')
    expect(pickLanguage(['pt'])).toBe('pt-PT')
    expect(pickLanguage(['ja-JP', 'de-AT'])).toBe('de')
    expect(pickLanguage(['ja-JP'])).toBe('en')
    expect(pickLanguage([])).toBe('en')
  })
})
