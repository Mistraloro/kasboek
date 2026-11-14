/** Names for the starting categories in each interface language. */
import { FALLBACKS, type LanguageCode } from '@shared/languages'
import { defaultCategories as de } from '../renderer/src/i18n/locales/de.json'
import { defaultCategories as es } from '../renderer/src/i18n/locales/es.json'
import { defaultCategories as es419 } from '../renderer/src/i18n/locales/es-419.json'
import { defaultCategories as fr } from '../renderer/src/i18n/locales/fr.json'
import { defaultCategories as nl } from '../renderer/src/i18n/locales/nl.json'
import { defaultCategories as ptBR } from '../renderer/src/i18n/locales/pt-BR.json'
import { defaultCategories as ptPT } from '../renderer/src/i18n/locales/pt-PT.json'

type Names = Record<string, string>
const BY_LANGUAGE: Partial<Record<LanguageCode, Names | undefined>> = {
  nl,
  fr,
  de,
  es,
  'es-419': es419 as Names,
  'pt-PT': ptPT,
  'pt-BR': ptBR as Names
}

/** English name → translated name; regional variants fill gaps from their base language. */
export function defaultCategoryNames(language: LanguageCode): Names {
  const chain = [language, ...(FALLBACKS[language] ?? [])].reverse()
  return Object.assign({}, ...chain.map((l) => BY_LANGUAGE[l] ?? {})) as Names
}
