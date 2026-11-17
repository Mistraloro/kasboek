import { errorKey, errorVars, type ErrorDetails } from '@shared/error-text'
import i18n, { aiProvider } from '../i18n'

/** An error from the main process in the person's language when there is a text for it, else its own message. No placeholder is ever left in it. */
export function errorMessage(e: { code: string; message: string; details?: ErrorDetails }): string {
  const key = errorKey(e.code, e.details)
  return i18n.exists(key) ? i18n.t(key, errorVars(aiProvider(), i18n.t('ai.neutralName'), e.details)) : e.message
}
