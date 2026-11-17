import { describe, expect, it } from 'vitest'
import i18n, { loadLanguage, switchLanguage } from '../src/renderer/src/i18n'

describe('locale loader', () => {
  it('starts with English only', () => {
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(true)
    expect(i18n.hasResourceBundle('nl', 'translation')).toBe(false)
  })

  it('loads a language on request and then translates with it', async () => {
    await switchLanguage('nl')
    expect(i18n.hasResourceBundle('nl', 'translation')).toBe(true)
    expect(i18n.language).toBe('nl')
    expect(i18n.t('nav.settings')).not.toBe('nav.settings')
    await i18n.changeLanguage('en')
  })

  it('also loads the base language a regional variant falls back to', async () => {
    await loadLanguage('pt-BR')
    expect(i18n.hasResourceBundle('pt-PT', 'translation')).toBe(true)
    expect(i18n.hasResourceBundle('pt-BR', 'translation')).toBe(true)
  })

  it('treats an unknown code as English', async () => {
    await expect(loadLanguage('xx')).resolves.toBeUndefined()
  })
})
