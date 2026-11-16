/**
 * Number, money and date formatting from the user's own choices, not tied to a language or
 * country. Each part (decimal mark, digit grouping, currency placement, date pattern, clock) is
 * set separately. Month names follow the interface language.
 */

export type DecimalSeparator = '.' | ','
export type GroupSeparator = ',' | '.' | ' ' | "'" | ''
export type Grouping = 'thousands' | 'indian'
export type CurrencyPosition = 'before' | 'before-space' | 'after' | 'after-space'
export type CurrencyStyle = 'symbol' | 'code'
export type NegativeStyle = 'minus' | 'minus-after-symbol' | 'parentheses'
export type TimeFormat = '24h' | '12h'

export interface FormatPrefs {
  decimal: DecimalSeparator
  group: GroupSeparator
  grouping: Grouping
  currencyPosition: CurrencyPosition
  currencyStyle: CurrencyStyle
  negative: NegativeStyle
  /** Pattern made of YYYY, YY, MMMM (January), MMM (Jan), MM (01), M (1), DD (05), D (5). */
  date: DatePattern
  time: TimeFormat
}

export const DECIMAL_SEPARATORS: DecimalSeparator[] = [',', '.']
export const GROUP_SEPARATORS: GroupSeparator[] = ['.', ',', ' ', "'", '']
export const GROUPINGS: Grouping[] = ['thousands', 'indian']
export const CURRENCY_POSITIONS: CurrencyPosition[] = ['after-space', 'after', 'before-space', 'before']
export const CURRENCY_STYLES: CurrencyStyle[] = ['symbol', 'code']
export const NEGATIVE_STYLES: NegativeStyle[] = ['minus', 'minus-after-symbol', 'parentheses']
export const TIME_FORMATS: TimeFormat[] = ['24h', '12h']
export const DATE_PATTERNS = [
  'DD/MM/YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'D/M/YYYY',
  'D.M.YYYY',
  'D-M-YYYY',
  'DD/MM/YY',
  'DD.MM.YY',
  'MM/DD/YYYY',
  'M/D/YYYY',
  'MM-DD-YYYY',
  'MM/DD/YY',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYY.MM.DD',
  'YY-MM-DD',
  'D MMM YYYY',
  'DD MMM YYYY',
  'D MMMM YYYY',
  'MMM D, YYYY',
  'MMMM D, YYYY',
  'YYYY MMM D'
] as const
export type DatePattern = (typeof DATE_PATTERNS)[number]

export const DEFAULT_FORMATS: FormatPrefs = {
  decimal: ',',
  group: '.',
  grouping: 'thousands',
  currencyPosition: 'after-space',
  currencyStyle: 'symbol',
  negative: 'minus',
  date: 'DD/MM/YYYY',
  time: '24h'
}

/**
 * Common styles to pick from in one go (the welcome window). Shown as examples, so they need no
 * names: "−1.234,56 € · 31/12/2026". Settings still has every separate option.
 */
export const FORMAT_PRESETS: { id: string; formats: FormatPrefs }[] = [
  { id: 'eu', formats: { ...DEFAULT_FORMATS } },
  { id: 'eu-dots', formats: { ...DEFAULT_FORMATS, date: 'DD.MM.YYYY' } },
  { id: 'eu-dashes', formats: { ...DEFAULT_FORMATS, date: 'DD-MM-YYYY' } },
  { id: 'fr', formats: { ...DEFAULT_FORMATS, group: ' ' } },
  { id: 'ch', formats: { ...DEFAULT_FORMATS, decimal: '.', group: "'", currencyPosition: 'before-space', date: 'DD.MM.YYYY' } },
  { id: 'uk', formats: { ...DEFAULT_FORMATS, decimal: '.', group: ',', currencyPosition: 'before' } },
  { id: 'us', formats: { ...DEFAULT_FORMATS, decimal: '.', group: ',', currencyPosition: 'before', date: 'MM/DD/YYYY', time: '12h' } },
  { id: 'iso', formats: { ...DEFAULT_FORMATS, decimal: '.', group: ' ', date: 'YYYY-MM-DD' } }
]

/** The preset these formats match exactly, or null when they were chosen one by one. */
export function matchingPreset(f: FormatPrefs): string | null {
  return FORMAT_PRESETS.find((p) => (Object.keys(p.formats) as (keyof FormatPrefs)[]).every((k) => p.formats[k] === f[k]))?.id ?? null
}

/** Formats from before separate settings existed (a single "format locale"). */
export function formatsFromLegacyLocale(locale: string | undefined): FormatPrefs {
  switch (locale) {
    case 'en-US':
      return { ...DEFAULT_FORMATS, decimal: '.', group: ',', currencyPosition: 'before', date: 'MM/DD/YYYY', time: '12h' }
    case 'en-GB':
      return { ...DEFAULT_FORMATS, decimal: '.', group: ',', currencyPosition: 'before' }
    case 'en-BE':
      return { ...DEFAULT_FORMATS, decimal: '.', group: ',', currencyPosition: 'before' }
    default:
      return { ...DEFAULT_FORMATS }
  }
}

/** Makes a stored or incoming value safe: unknown values fall back, separators never clash. */
export function normalizeFormats(input: Partial<FormatPrefs> | undefined, base: FormatPrefs = DEFAULT_FORMATS): FormatPrefs {
  const pick = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
  const f: FormatPrefs = {
    decimal: pick(input?.decimal, DECIMAL_SEPARATORS, base.decimal),
    group: pick(input?.group, GROUP_SEPARATORS, base.group),
    grouping: pick(input?.grouping, GROUPINGS, base.grouping),
    currencyPosition: pick(input?.currencyPosition, CURRENCY_POSITIONS, base.currencyPosition),
    currencyStyle: pick(input?.currencyStyle, CURRENCY_STYLES, base.currencyStyle),
    negative: pick(input?.negative, NEGATIVE_STYLES, base.negative),
    date: isDatePattern(input?.date) ? input.date : base.date,
    time: pick(input?.time, TIME_FORMATS, base.time)
  }
  if (f.group === f.decimal) f.group = f.decimal === ',' ? '.' : ','
  return f
}

export function isDatePattern(v: unknown): v is DatePattern {
  return typeof v === 'string' && (DATE_PATTERNS as readonly string[]).includes(v)
}

/* ---------- Numbers ---------- */

const NARROW_NBSP = '\u202F'

function groupDigits(digits: string, f: FormatPrefs): string {
  const sep = f.group === ' ' ? NARROW_NBSP : f.group
  if (!sep || digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  let rest = digits.slice(0, -3)
  const size = f.grouping === 'indian' ? 2 : 3
  const parts: string[] = []
  while (rest.length > size) {
    parts.unshift(rest.slice(-size))
    rest = rest.slice(0, -size)
  }
  if (rest) parts.unshift(rest)
  return [...parts, last3].join(sep)
}

/** A plain number with the chosen separators, e.g. 1234.5 → "1.234,50". */
export function formatNumber(value: number, f: FormatPrefs, fractionDigits = 2): string {
  const negative = value < 0
  const [whole, frac] = Math.abs(value).toFixed(fractionDigits).split('.')
  const text = groupDigits(whole!, f) + (frac ? f.decimal + frac : '')
  return negative && Number(Math.abs(value).toFixed(fractionDigits)) !== 0 ? '−' + text : text
}

const fractionCache = new Map<string, number>()
/** Minor-unit digits of a currency (EUR 2, JPY 0, BHD 3). */
export function currencyDigits(currency: string): number {
  let d = fractionCache.get(currency)
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      d = 2
    }
    fractionCache.set(currency, d)
  }
  return d
}

const symbolCache = new Map<string, string>()
export function currencySymbol(currency: string): string {
  let s = symbolCache.get(currency)
  if (s === undefined) {
    try {
      s = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'symbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
    } catch {
      s = currency
    }
    symbolCache.set(currency, s)
  }
  return s
}

/**
 * Money from integer minor units. Amounts are stored in cents (two decimals) for every currency,
 * so a currency without decimals (JPY) is rounded for display only.
 */
export function formatMoney(cents: number, currency: string, f: FormatPrefs): string {
  const digits = Math.min(currencyDigits(currency), 2)
  const value = Math.abs(cents) / 100
  const number = formatNumber(value, f, digits)
  const isNegative = cents < 0 && number.replace(/[^1-9]/g, '') !== ''
  const unit = f.currencyStyle === 'code' ? currency : currencySymbol(currency)
  // A code (EUR) always needs a space; a symbol only when chosen.
  const space = f.currencyPosition.endsWith('space') || unit.length > 1 && /^[A-Z]+$/.test(unit) ? '\u00A0' : ''
  const before = f.currencyPosition.startsWith('before')
  if (!isNegative) return before ? unit + space + number : number + space + unit
  if (f.negative === 'parentheses') return '(' + (before ? unit + space + number : number + space + unit) + ')'
  if (f.negative === 'minus-after-symbol' && before) return unit + space + '−' + number
  return '−' + (before ? unit + space + number : number + space + unit)
}

/** A cents value as the user would type it back in an input, e.g. -123450 → "-1234,50". */
export function centsToInput(cents: number, f: FormatPrefs): string {
  const s = (cents / 100).toFixed(2)
  return f.decimal === ',' ? s.replace('.', ',') : s
}

/* ---------- Dates ---------- */

function monthName(month: number, language: string, style: 'short' | 'long'): string {
  try {
    return new Intl.DateTimeFormat(language, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month, 1))).replace(/\.$/, '')
  } catch {
    return String(month + 1)
  }
}

/** Splits an ISO date or date-time into local calendar parts. A bare date stays that date. */
function parts(input: string | Date): { y: number; m: number; d: number; h: number; min: number } {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number)
    return { y: y!, m: m! - 1, d: d!, h: 0, min: 0 }
  }
  const date = typeof input === 'string' ? new Date(input) : input
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), h: date.getHours(), min: date.getMinutes() }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatDate(input: string | Date, f: FormatPrefs, language = 'en'): string {
  const p = parts(input)
  return f.date.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(p.y)
      case 'YY':
        return pad(p.y % 100)
      case 'MMMM':
        return monthName(p.m, language, 'long')
      case 'MMM':
        return monthName(p.m, language, 'short')
      case 'MM':
        return pad(p.m + 1)
      case 'M':
        return String(p.m + 1)
      case 'DD':
        return pad(p.d)
      default:
        return String(p.d)
    }
  })
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The month (0-11) a typed name stands for in this language, short or long, or -1. */
function monthFromName(name: string, language: string): number {
  const wanted = name.toLowerCase().replace(/\.$/, '')
  for (let m = 0; m < 12; m++) {
    if (monthName(m, language, 'short').toLowerCase() === wanted || monthName(m, language, 'long').toLowerCase() === wanted) return m
  }
  return -1
}

/**
 * Reads a date typed in the chosen pattern and returns it as ISO "YYYY-MM-DD", or null when it
 * is not a real calendar date. Day and month may be typed with or without a leading zero, and a
 * plain ISO date is always accepted. Two-digit years count as 20YY.
 */
export function parseDate(text: string, f: FormatPrefs, language = 'en'): string | null {
  const input = text.trim()
  if (!input) return null
  const order: string[] = []
  const source = f.date.replace(/(YYYY|YY|MMMM|MMM|MM|M|DD|D)|([^YMD]+)/g, (_all, token: string | undefined, literal: string | undefined) => {
    if (literal !== undefined) return /^\s+$/.test(literal) ? '\\s+' : escapeRegExp(literal).replace(/\s+/g, '\\s*')
    order.push(token!)
    if (token === 'YYYY') return '(\\d{4})'
    if (token === 'YY') return '(\\d{2})'
    return token!.startsWith('MMM') ? '(\\p{L}+\\.?)' : '(\\d{1,2})'
  })
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  const match = iso ?? new RegExp(`^${source}$`, 'u').exec(input)
  if (!match) return null
  let y = 0
  let m = -1
  let d = 0
  const values = iso ? ['YYYY', 'MM', 'DD'] : order
  values.forEach((token, i) => {
    const v = match[i + 1]!
    if (token === 'YYYY') y = Number(v)
    else if (token === 'YY') y = 2000 + Number(v)
    else if (token === 'MMMM' || token === 'MMM') m = monthFromName(v, language)
    else if (token === 'MM' || token === 'M') m = Number(v) - 1
    else d = Number(v)
  })
  if (y < 1 || m < 0 || m > 11 || d < 1) return null
  const probe = new Date(Date.UTC(2000, m, d))
  probe.setUTCFullYear(y)
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m || probe.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${pad(m + 1)}-${pad(d)}`
}

/** What a date text field holds: the ISO date ('' when empty or unusable) and what is wrong, if anything. */
export function checkDateText(text: string, f: FormatPrefs, language = 'en', max?: string): { iso: string; problem: 'invalid' | 'tooLate' | null } {
  if (!text.trim()) return { iso: '', problem: null }
  const iso = parseDate(text, f, language)
  if (iso === null) return { iso: '', problem: 'invalid' }
  if (max && iso > max) return { iso: '', problem: 'tooLate' }
  return { iso, problem: null }
}

/** The pattern to show as a hint or placeholder for the chosen date format, e.g. "DD/MM/YYYY". */
export function datePlaceholder(f: FormatPrefs): string {
  return f.date
}

/** An example date written in the chosen format: today's local date, e.g. "16/11/2026". */
export function dateExample(f: FormatPrefs, language = 'en', today: Date = new Date()): string {
  return formatDate(today, f, language)
}

export function formatTime(input: string | Date, f: FormatPrefs): string {
  const p = parts(input)
  if (f.time === '24h') return `${pad(p.h)}:${pad(p.min)}`
  const h = p.h % 12 === 0 ? 12 : p.h % 12
  return `${h}:${pad(p.min)} ${p.h < 12 ? 'AM' : 'PM'}`
}

export function formatDateTime(input: string | Date, f: FormatPrefs, language = 'en'): string {
  return `${formatDate(input, f, language)} ${formatTime(input, f)}`
}
