/** Formats integer cents as money, e.g. -123450 → "-€1,234.50" (en-BE). */
export function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}

export function formatDate(iso: string, locale: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return new Intl.DateTimeFormat(locale, opts).format(new Date(iso))
}

export function formatDateTime(iso: string, locale: string): string {
  return formatDate(iso, locale, { dateStyle: 'medium', timeStyle: 'short' })
}

export function monthLabel(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date)
}
