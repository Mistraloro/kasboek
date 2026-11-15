/** Months are 'YYYY-MM' strings everywhere. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function monthOf(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** Today as 'YYYY-MM-DD' on the person's own clock (not UTC: just after midnight it's already the new day). */
export function localToday(date: Date = new Date()): string {
  return `${monthOf(date)}-${String(date.getDate()).padStart(2, '0')}`
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(y, m - 1 + n, 1)
  return monthOf(d)
}

export function monthRange(month: string): { from: string; to: string } {
  const next = addMonths(month, 1)
  return { from: `${month}-01`, to: `${next}-01` }
}
