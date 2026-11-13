import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'

/**
 * UI languages. To add one: copy locales/en.json to e.g. nl.json, translate the
 * values, and add it here. Keys missing from a translation fall back to English.
 */
export const LANGUAGES = [{ code: 'en', label: 'English' }] as const

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false, defaultVariables: { ai: 'Claude', aiCompany: 'Anthropic' } },
  returnNull: false
})

/** The assistant's name in texts; follows the chosen AI provider. */
export function setAiName(name: string, company: string | null): void {
  const vars = i18n.options.interpolation?.defaultVariables as Record<string, string> | undefined
  if (vars) {
    vars['ai'] = name
    vars['aiCompany'] = company ?? ''
  }
}

export default i18n
