/**
 * IBANs in free text: finding them and hiding them. Account numbers don't help the assistant: only
 * the country and the last four digits are sent. Also found when stuck to other text
 * ("…864551BE29001477…" in a mandate reference); a candidate only counts when its IBAN checksum is
 * right, so other codes are left alone.
 */
const IBAN = /(?<![A-Z])([A-Z]{2})(\d{2})((?:[ ]?[A-Z0-9]){10,30})/g
const IBAN_LENGTH: Record<string, number> = { BE: 16, NL: 18, FR: 27, DE: 22, LU: 20, ES: 24, PT: 25, IT: 27, GB: 22, IE: 22, AT: 20, CH: 21, LT: 20, MT: 31 }

export function validIban(iban: string): boolean {
  const re = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rem = 0
  for (const ch of re) rem = (rem * 10 + Number(ch)) % 97
  return rem === 1
}

/** The valid IBAN at the start of a candidate match, and how many characters of the match it used. */
function resolve(m: string, cc: string): { iban: string; used: number } | null {
  const compact = m.replace(/\s/g, '')
  // Try the country's length first (the match may run on into other text), then shorter ones.
  const lengths = IBAN_LENGTH[cc] ? [IBAN_LENGTH[cc]!] : Array.from({ length: compact.length - 13 }, (_, i) => compact.length - i)
  for (const len of lengths) {
    const candidate = compact.slice(0, len)
    if (candidate.length === len && validIban(candidate)) {
      let used = 0
      let count = 0
      while (count < len && used < m.length) if (m[used++] !== ' ') count++
      return { iban: candidate, used }
    }
  }
  return null
}

export const maskIban = (text: string): string =>
  text.replace(IBAN, (m, cc: string) => {
    const found = resolve(m, cc)
    // Keep what followed the account number.
    return found ? `${cc}…${found.iban.slice(-4)}${m.slice(found.used)}` : m
  })

/** The valid IBANs in a text, without spaces and in order of appearance, each once. */
export function findIbans(text: string): string[] {
  const found: string[] = []
  const re = new RegExp(IBAN.source, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const hit = resolve(m[0], m[1]!)
    if (!hit) continue
    if (!found.includes(hit.iban)) found.push(hit.iban)
    // Carry on after the account number: another one may follow right behind it.
    re.lastIndex = m.index + hit.used
  }
  return found
}

/** IBANs as maskIban shows them, and runs of 13 or more digits (card or account numbers) by their last four. */
export const maskNumbers = (text: string): string => maskIban(text).replace(/\d(?:[ -]?\d){12,}/g, (m) => `…${m.replace(/\D/g, '').slice(-4)}`)
