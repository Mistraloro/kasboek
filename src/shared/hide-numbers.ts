import { maskAccount, maskNumbers } from './iban'

/** What the screen shows for one account number: CC…1234 while numbers are hidden, else the number in groups of four. */
export const shownAccount = (value: string, hidden: boolean): string =>
  hidden ? maskAccount(value.replace(/\s+/g, '')) : value.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()

/** What the screen shows for a free text (a description, a name): account and card numbers in it as CC…1234 or …1234 while numbers are hidden. */
export const shownText = (text: string, hidden: boolean): string => (hidden ? maskNumbers(text) : text)
