import * as f from '@shared/format'
import type { FormatPrefs } from '@shared/format'

/** What the UI needs to format: the user's chosen formats plus the language for month names. */
export interface Fmt {
  formats: FormatPrefs
  language: string
}

export function formatMoney(cents: number, currency: string, fmt: Fmt): string {
  return f.formatMoney(cents, currency, fmt.formats)
}

export function formatDate(iso: string | Date, fmt: Fmt): string {
  return f.formatDate(iso, fmt.formats, fmt.language)
}

export function formatDateTime(iso: string | Date, fmt: Fmt): string {
  return f.formatDateTime(iso, fmt.formats, fmt.language)
}

export function formatNumber(value: number, fmt: Fmt, digits = 2): string {
  return f.formatNumber(value, fmt.formats, digits)
}

/** "January 2026" in the interface language. */
export function monthLabel(date: Date, fmt: Fmt): string {
  return new Intl.DateTimeFormat(fmt.language, { month: 'long', year: 'numeric' }).format(date)
}

/** "Jan" in the interface language. */
export function monthShort(date: Date, fmt: Fmt): string {
  return new Intl.DateTimeFormat(fmt.language, { month: 'short' }).format(date).replace(/\.$/, '')
}
