/**
 * IBANs in free text: finding them and hiding them. Account numbers don't help the assistant: only
 * the country and the last four digits are sent. Also found when stuck to other text, before or after
 * ("REFNL91ABNA0417164300", "…864551BE29001477…" in a mandate reference), and in lower case; a
 * candidate only counts when its IBAN checksum is right, so other codes are left alone. A country
 * code that is not in the table of lengths below only counts at the start of a word, because without
 * a known length any run of letters and digits has a fair chance of passing the checksum.
 *
 * Every text is first folded (see `fold`): compatibility forms such as full-width digits become plain
 * ones, and every kind of white space, zero-width character and dash becomes one space or hyphen, so
 * that an IBAN split by a line break or written with non-breaking spaces is still found. The groups
 * of an account number may be separated by a space, a dot, a hyphen or a slash. When nothing in a text
 * is hidden, the text is returned exactly as it came.
 */
const IBAN = /([A-Z]{2})(\d{2})((?:[ .\-/]?[A-Z0-9]){10,30})/gi
// Length of an IBAN per country (the IBAN registry).
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20
}

/** The characters that may separate the groups of an account or card number. */
const SEP = '[ .\\-/]'

/** Compatibility forms (full-width digits, …) as plain ones; all white space as one space; zero-width characters gone; every dash as a hyphen. */
const fold = (text: string): string =>
  // NFKC would turn the … of a masked number into three dots, so it is applied between the …s only.
  text
    .split('…')
    .map((part) => part.normalize('NFKC'))
    .join('…')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')

/** Runs a masking step on the folded text; a text that the step left alone is returned as it came. */
const masking =
  (step: (folded: string) => string) =>
  (text: string): string => {
    const folded = fold(text)
    const out = step(folded)
    return out === folded ? text : out
  }

export function validIban(iban: string): boolean {
  const re = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rem = 0
  for (const ch of re) rem = (rem * 10 + Number(ch)) % 97
  return rem === 1
}

/**
 * For a country that is not in the table: the lengths (longest first, at least 15) at which the start of the text passes the checksum,
 * all found in one pass over the text instead of one per length.
 */
function lengthsWithValidChecksum(compact: string): number[] {
  const digits = (c: string): string => (c >= 'A' ? String(c.charCodeAt(0) - 55) : c)
  const head = [...compact.slice(0, 4)].map(digits).join('')
  const found: number[] = []
  let rem = 0
  for (let len = 5; len <= compact.length; len++) {
    for (const d of digits(compact[len - 1]!)) rem = (rem * 10 + Number(d)) % 97
    if (len >= 15 && (rem * 10 ** head.length + Number(head)) % 97 === 1) found.push(len)
  }
  return found.reverse()
}

const isSep = (c: string | undefined): boolean => c === ' ' || c === '.' || c === '-' || c === '/'

/** The valid IBAN at the start of a candidate match, and how many characters of the match it used. */
function resolve(m: string, cc: string): { iban: string; used: number } | null {
  const compact = m.replace(/[ .\-/]/g, '').toUpperCase()
  // Try the country's length first (the match may run on into other text), then shorter ones.
  const lengths = IBAN_LENGTH[cc] ? [IBAN_LENGTH[cc]!] : lengthsWithValidChecksum(compact)
  for (const len of lengths) {
    const candidate = compact.slice(0, len)
    if (candidate.length === len && validIban(candidate)) {
      let used = 0
      let count = 0
      while (count < len && used < m.length) if (!isSep(m[used++])) count++
      return { iban: candidate, used }
    }
  }
  return null
}

interface Hit {
  index: number
  cc: string
  iban: string
  /** How many characters of the text the account number takes, separators included. */
  used: number
}

/** The valid IBANs in a (folded) text, in order of appearance. A failed candidate is tried again one character further, so a real one inside it is still found. */
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

function ibansHidden(text: string): string {
  let out = ''
  let at = 0
  for (const h of scan(text)) {
    out += `${text.slice(at, h.index)}${h.cc}…${h.iban.slice(-4)}`
    at = h.index + h.used
  }
  return out + text.slice(at)
}

export const maskIban = masking(ibansHidden)

/**
 * An account number as a whole value: CC…1234 for an IBAN, never more than the country and the last
 * four characters, also when it is not a valid one (a local number such as 123-4567890-12 gives
 * …9012, and a value of four characters or fewer gives …). A value that is already masked stays.
 */
export function maskAccount(text: string): string {
  const v = fold(text).trim()
  if (/^(?:[A-Za-z]{2})?…\d{0,4}$/.test(v)) return v
  const masked = ibansHidden(v)
  if (masked !== v) return masked
  const compact = v.replace(/[ .\-/]/g, '')
  if (compact.length <= 4) return '…'
  const cc = /^[A-Za-z]{2}/.test(compact) && compact.length >= 9 ? compact.slice(0, 2) : ''
  return `${cc}…${compact.slice(-4)}`
}

/** The valid IBANs in a text, without spaces and in order of appearance, each once. */
export const findIbans = (text: string): string[] => [...new Set(scan(fold(text)).map((h) => h.iban))]

const DAY = '(?:0[1-9]|[12]\\d|3[01])'
const MONTH = '(?:0[1-9]|1[0-2])'
const YEAR = '(?:19|20)\\d{2}'
/** A plausible date (a real day and month): dd-mm-yyyy or yyyy-mm-dd, also with / or . between the parts. */
const DATE = ['-', '/', '\\.'].map((s) => `${DAY}${s}${MONTH}${s}${YEAR}|${YEAR}${s}${MONTH}${s}${DAY}`).join('|')
/** An amount with thousands separators (1.234.567,89, 1,234.50): up to seven digits before the decimals. */
const AMOUNT = '(?<![\\d.,])\\d{1,3}(?:[.,]\\d{3}){1,2}(?:[.,]\\d{1,2})?(?!\\d)'
const TRAILING_DATE = new RegExp(`${SEP}(?:${DATE})$`)
const NUMBERS = new RegExp(`((?<!\\d)(?:${DATE})(?!\\d)|${AMOUNT})|\\d(?:${SEP}?\\d){12,}`, 'g')
const digitsIn = (s: string): number => s.replace(/\D/g, '').length

/** Dates or amounts at the end of a text: the text without them, and them. */
function splitTrailingDates(text: string, minDigits: number): [string, string] {
  let head = text
  let tail = ''
  for (let t = TRAILING_DATE.exec(head); t; t = TRAILING_DATE.exec(head)) {
    const next = head.slice(0, t.index)
    if (digitsIn(next) < minDigits) break
    tail = head.slice(t.index) + tail
    head = next
  }
  return [head, tail]
}

/**
 * IBANs as maskIban shows them, and runs of 13 or more digits (card or account numbers) by their last
 * four. Dates and amounts stay, also right next to such a run or after it.
 */
export const maskNumbers = masking((text) =>
  ibansHidden(text).replace(NUMBERS, (m, keep: string | undefined) => {
    if (keep) return m
    const [head, tail] = splitTrailingDates(m, 13)
    return `…${head.replace(/\D/g, '').slice(-4)}${tail}`
  })
)

const MAIL_PART = /[^\s@<>()|]/
const MAIL_LOCAL = 100
const MAIL_DOMAIN = 255

/** The e-mail addresses in a text hidden. Scans from each @ outwards, with a limit on both sides, so a long text can't make it slow. */
function mailsHidden(text: string): string {
  let out = ''
  let at = 0
  for (let i = text.indexOf('@', 0); i >= 0; i = text.indexOf('@', i + 1)) {
    let from = i
    while (from > at && i - from < MAIL_LOCAL && MAIL_PART.test(text[from - 1]!)) from--
    let to = i + 1
    while (to < text.length && to - i <= MAIL_DOMAIN && MAIL_PART.test(text[to]!)) to++
    const domain = text.slice(i + 1, to)
    const dot = domain.indexOf('.', 1)
    if (from === i || dot < 0 || dot >= domain.length - 1) continue
    out += `${text.slice(at, from)}…@…`
    at = to
    i = to - 1
  }
  return out + text.slice(at)
}

const PHONE = /(?:\+|\b00)\d[\d ./()-]{6,30}\d/g
/** +1.234.567: an amount with a plus sign, not a phone number (a phone number has eight digits or more). */
const SIGNED_AMOUNT = /^\+\d{1,3}(?:[.,]\d{3}){1,2}$/

/** An e-mail address, or a phone number written with a + or 00 prefix (an international number). Cheap and not exhaustive. */
export const maskContacts = masking((text) =>
  mailsHidden(text).replace(PHONE, (m) => {
    if (SIGNED_AMOUNT.test(m) && digitsIn(m) <= 7) return m
    const [, tail] = splitTrailingDates(m, 7)
    return `…phone…${tail}`
  })
)

/** What a number, address or phone number cut off at the end of a masked prefix can leave unmasked: well under this many characters. */
const EDGE = 400

/**
 * Everything that must not leave the device or show on a screen that is being watched: account and
 * card numbers first, then e-mail addresses and phone numbers (the other way round, the phone rule
 * would eat the groups of a spaced IBAN). `max` cuts the text to that many characters, after masking:
 * masks shrink a text, so cutting first would let unmasked text slide under the cut. A long text is
 * masked as a prefix only; the prefix grows until its masked form is EDGE longer than `max`, so
 * whatever the prefix edge left half-masked lies beyond the cut.
 */
export function maskPrivate(text: string, max?: number): string {
  if (max === undefined || text.length <= max) return maskContacts(maskNumbers(text))
  for (let length = max * 4 + EDGE; ; length *= 4) {
    const masked = maskContacts(maskNumbers(text.slice(0, length)))
    if (length >= text.length || masked.length >= max + EDGE) return `${masked.slice(0, max)}…`
  }
}

/** The first `max` characters of a text, but never through the middle of an account or card number: one that would be cut in two is left out whole, so no part of it is shown. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const window = fold(text.slice(0, max + 64))
  let cut = max
  const straddles = (index: number, length: number): boolean => index < cut && index + length > cut
  for (const h of scan(window)) if (straddles(h.index, h.used)) cut = h.index
  for (const m of window.matchAll(NUMBERS)) if (!m[1] && straddles(m.index, m[0].length)) cut = m.index
  return text.slice(0, cut)
}
