import { maskAccount, maskNumbers, validIban } from './iban'

/** What the screen shows for one account number: CC…1234 while numbers are hidden, else a valid IBAN in groups of four; any other number is shown as it is. */
export const shownAccount = (value: string, hidden: boolean): string => {
  if (hidden) return maskAccount(value)
  const compact = value.replace(/\s+/g, '')
  return /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}$/.test(compact) && validIban(compact.toUpperCase()) ? compact.replace(/(.{4})/g, '$1 ').trim() : value
}

/** What the screen shows for a free text (a description, a name): account and card numbers in it as CC…1234 or …1234 while numbers are hidden. */
export const shownText = (text: string, hidden: boolean): string => (hidden ? maskNumbers(text) : text)

/**
 * A text field that may hold account numbers: while numbers are hidden and the field is not focused (and the eye is not held)
 * it shows the masked text and is read-only, so what is typed or saved is always the real value, never the masked one.
 * The field is only masked when something in it is hidden.
 */
export function fieldView(value: string, state: { hidden: boolean; focused: boolean; shown: boolean }): { text: string; readOnly: boolean } {
  const text = state.hidden && !state.focused && !state.shown ? shownText(value, true) : value
  return { text, readOnly: text !== value }
}
