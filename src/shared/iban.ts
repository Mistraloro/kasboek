/**
 * IBANs in free text: finding them and hiding them. Account numbers don't help the assistant: only
 * the country and the last four digits are sent. Also found when stuck to other text, before or after
 * ("REFNL91ABNA0417164300", "…864551BE29001477…" in a mandate reference), and in lower case; a
 * candidate only counts when its IBAN checksum is right, so other codes are left alone. A country
 * code that is not in the table of lengths below only counts at the start of a word, because without
 * a known length any run of letters and digits has a fair chance of passing the checksum.
 */
const IBAN = /([A-Z]{2})(\d{2})((?:[ ]?[A-Z0-9]){10,30})/gi
// Length of an IBAN per country (the IBAN registry).
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20
}

export function validIban(iban: string): boolean {
  const re = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rem = 0
  for (const ch of re) rem = (rem * 10 + Number(ch)) % 97
  return rem === 1
}

/** The valid IBAN at the start of a candidate match, and how many characters of the match it used. */
function resolve(m: string, cc: string): { iban: string; used: number } | null {
  const compact = m.replace(/\s/g, '').toUpperCase()
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

interface Hit {
  index: number
  cc: string
  iban: string
  /** How many characters of the text the account number takes, spaces included. */
  used: number
}

/** The valid IBANs in a text, in order of appearance. A failed candidate is tried again one character further, so a real one inside it is still found. */
function scan(text: string): Hit[] {
  const hits: Hit[] = []
  const re = new RegExp(IBAN.source, 'gi')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cc = m[1]!.toUpperCase()
    const hit = IBAN_LENGTH[cc] || !/[A-Za-z]/.test(text[m.index - 1] ?? '') ? resolve(m[0], cc) : null
    if (!hit) {
      re.lastIndex = m.index + 1
      continue
    }
    hits.push({ index: m.index, cc, iban: hit.iban, used: hit.used })
    // Carry on after the account number: another one may follow right behind it.
    re.lastIndex = m.index + hit.used
  }
  return hits
}

export function maskIban(text: string): string {
  let out = ''
  let at = 0
  for (const h of scan(text)) {
    out += `${text.slice(at, h.index)}${h.cc}…${h.iban.slice(-4)}`
    at = h.index + h.used
  }
  return out + text.slice(at)
}

/** The valid IBANs in a text, without spaces and in order of appearance, each once. */
export const findIbans = (text: string): string[] => [...new Set(scan(text).map((h) => h.iban))]

const DAY = '(?:0[1-9]|[12]\\d|3[01])'
const MONTH = '(?:0[1-9]|1[0-2])'
const YEAR = '(?:19|20)\\d{2}'
const DATE = `(?:${DAY}-${MONTH}-${YEAR}|${YEAR}-${MONTH}-${DAY})`
/** Only plausible dates (dd-mm-yyyy or yyyy-mm-dd, a real day and month) side by side: 13 or more digits, but not a number. */
const DATES_ONLY = new RegExp(`^${DATE}(?:[ -]${DATE})*$`)

/** IBANs as maskIban shows them, and runs of 13 or more digits (card or account numbers) by their last four. Dates side by side stay. */
export const maskNumbers = (text: string): string =>
  maskIban(text).replace(/\d(?:[ -]?\d){12,}/g, (m) => (DATES_ONLY.test(m) ? m : `…${m.replace(/\D/g, '').slice(-4)}`))
