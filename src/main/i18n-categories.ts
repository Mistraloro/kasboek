/** Names for the starting categories in each interface language. */
import { FALLBACKS, type LanguageCode } from '@shared/languages'
import de from '../renderer/src/i18n/locales/de.json'
import es from '../renderer/src/i18n/locales/es.json'
import es419 from '../renderer/src/i18n/locales/es-419.json'
import fr from '../renderer/src/i18n/locales/fr.json'
import nl from '../renderer/src/i18n/locales/nl.json'
import ptBR from '../renderer/src/i18n/locales/pt-BR.json'
import ptPT from '../renderer/src/i18n/locales/pt-PT.json'

type Names = Record<string, string>
const BY_LANGUAGE: Partial<Record<LanguageCode, Names | undefined>> = {
  nl: nl.defaultCategories,
  fr: fr.defaultCategories,
  de: de.defaultCategories,
  es: es.defaultCategories,
  'es-419': (es419 as { defaultCategories?: Names }).defaultCategories,
  'pt-PT': ptPT.defaultCategories,
  'pt-BR': (ptBR as { defaultCategories?: Names }).defaultCategories
}

/** English name → translated name; regional variants fill gaps from their base language. */
export function defaultCategoryNames(language: LanguageCode): Names {
  const chain = [language, ...(FALLBACKS[language] ?? [])].reverse()
  return Object.assign({}, ...chain.map((l) => BY_LANGUAGE[l] ?? {})) as Names
}
