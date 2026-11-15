/** An IBAN (also written in groups, "BE68 5390 0754 7034"), or a long run of digits like a card number. */
export function looksSensitive(text: string): boolean {
  if (/\b[A-Z]{2}\d{2}(?:[ .-]?[A-Z0-9]){10,30}\b/.test(text)) return true
  return /(?:\d[ -]?){13,}/.test(text)
}

export const SENSITIVE_MESSAGE = 'Kasboek does not remember account or card numbers. Leave the number out.'
