/** Interface languages, each named in its own language. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español (España)' },
  { code: 'es-419', label: 'Español (Latinoamérica)' },
  { code: 'pt-PT', label: 'Português (Portugal)' },
  { code: 'pt-BR', label: 'Português (Brasil)' }
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as LanguageCode[]

/** Regional variants only hold the texts that differ from their base. */
export const FALLBACKS: Partial<Record<LanguageCode, LanguageCode[]>> = { 'es-419': ['es', 'en'], 'pt-BR': ['pt-PT', 'en'] }

/**
 * The best interface language for the system's preferred languages (e.g. ["nl-BE", "en-US"]):
 * an exact match first, then Latin American Spanish for es-XX outside Spain, Brazilian
 * Portuguese for pt-BR, then the base language.
 */
export function pickLanguage(preferred: readonly string[]): LanguageCode {
  for (const raw of preferred) {
    const tag = raw.replace('_', '-')
    const exact = LANGUAGE_CODES.find((c) => c.toLowerCase() === tag.toLowerCase())
    if (exact) return exact
    const [base, region] = tag.split('-')
    if (base === 'es') return region && region.toUpperCase() !== 'ES' ? 'es-419' : 'es'
    if (base === 'pt') return region?.toUpperCase() === 'BR' ? 'pt-BR' : 'pt-PT'
    const match = LANGUAGE_CODES.find((c) => c === base)
    if (match) return match
  }
  return 'en'
}
