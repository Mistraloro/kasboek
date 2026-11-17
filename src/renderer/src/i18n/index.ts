import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { ErrorProvider } from '@shared/error-text'
import { FALLBACKS, LANGUAGE_CODES } from '@shared/languages'
import de from './locales/de.json'
import en from './locales/en.json'
import es from './locales/es.json'
import es419 from './locales/es-419.json'
import fr from './locales/fr.json'
import nl from './locales/nl.json'
import ptBR from './locales/pt-BR.json'
import ptPT from './locales/pt-PT.json'

export { LANGUAGES } from '@shared/languages'

/**
 * UI languages. Regional variants (es-419, pt-BR) hold only the texts that differ and fall back
 * to their base language, then English. Keys missing from a translation fall back to English.
 */
const resources = { en, nl, fr, de, es, 'es-419': es419, 'pt-PT': ptPT, 'pt-BR': ptBR }
void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(LANGUAGE_CODES.map((c) => [c, { translation: resources[c] }])),
  lng: 'en',
  fallbackLng: { ...FALLBACKS, default: ['en'] },
  interpolation: { escapeValue: false, defaultVariables: { ai: 'Claude', aiCompany: 'Anthropic' } },
  returnNull: false
})

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
