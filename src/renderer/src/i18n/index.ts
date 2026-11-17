import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { ErrorProvider } from '@shared/error-text'
import { FALLBACKS, LANGUAGE_CODES, type LanguageCode } from '@shared/languages'
import en from './locales/en.json'

export { LANGUAGES } from '@shared/languages'

/** Every language except English (which is always loaded) is its own chunk, fetched when first needed. */
const loaders: Record<Exclude<LanguageCode, 'en'>, () => Promise<{ default: object }>> = {
  nl: () => import('./locales/nl.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  'es-419': () => import('./locales/es-419.json'),
  'pt-PT': () => import('./locales/pt-PT.json'),
  'pt-BR': () => import('./locales/pt-BR.json')
}

/**
 * UI languages. Regional variants (es-419, pt-BR) hold only the texts that differ and fall back
 * to their base language, then English. Keys missing from a translation fall back to English.
 */
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: { ...FALLBACKS, default: ['en'] },
  interpolation: { escapeValue: false, defaultVariables: { ai: 'Claude', aiCompany: 'Anthropic' } },
  returnNull: false
})

/** Makes a language (and the languages it falls back to) available. Call before switching to it. */
export async function loadLanguage(code: string): Promise<void> {
  const wanted = (LANGUAGE_CODES as string[]).includes(code) ? (code as LanguageCode) : 'en'
  const codes = [wanted, ...(FALLBACKS[wanted] ?? [])]
  await Promise.all(
    codes.map(async (c) => {
      if (c === 'en' || i18n.hasResourceBundle(c, 'translation')) return
      const mod = await loaders[c]()
      i18n.addResourceBundle(c, 'translation', mod.default, true, false)
    })
  )
}

let latestSwitch = 0

/** Loads a language, then makes it the active one. A switch that was overtaken by a newer one while loading changes nothing. */
export async function switchLanguage(code: string): Promise<void> {
  const mine = ++latestSwitch
  await loadLanguage(code)
  if (mine !== latestSwitch) return
  await i18n.changeLanguage(code)
}

let provider: ErrorProvider | null = null

/** The AI provider in use, or null until it is known. */
export const aiProvider = (): ErrorProvider | null => provider

/** The assistant's name in texts; follows the chosen AI provider. */
export function setAiName(name: string, company: string | null): void {
  provider = { name, company }
  const vars = i18n.options.interpolation?.defaultVariables as Record<string, string> | undefined
  if (vars) {
    vars['ai'] = name
    vars['aiCompany'] = company ?? ''
  }
}

export default i18n
