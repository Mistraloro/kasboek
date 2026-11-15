/** Turns mapped CSV rows into clean transactions, recording every problem instead of guessing silently. */
import { parseAmount } from '@shared/amount'
import type { CsvMapping } from './mapping'

export type RowIssue = 'date_invalid' | 'amount_invalid' | 'amount_zero' | 'status_refused' | 'currency_other'

export interface CleanRow {
  /** Index in the data rows (0 = first row after the header). */
  index: number
  line: number
  bookingDate: string | null
  valueDate: string | null
  amountCents: number | null
  currency: string | null
  description: string
  counterpartyName: string | null
  counterpartyIban: string | null
  communication: string | null
  bankReference: string | null
  /** The account balance after this transaction, when the file has it. */
  balanceCents: number | null
  issues: RowIssue[]
  raw: string[]
}

export function parseDate(text: string, order: CsvMapping['dateOrder']): string | null {
  const s = text.trim().split(/[ T]/)[0] ?? ''
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(s)) [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6))]
  else {
    const parts = s.split(/[-/.]/).map(Number)
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null
    if (order === 'YMD') [y, m, d] = parts as [number, number, number]
    else if (order === 'MDY') [m, d, y] = parts as [number, number, number]
    else [d, m, y] = parts as [number, number, number]
  }
  if (y < 100) y += 2000
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1990 || y > 2100) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Belgian structured communication (OGM/VCS): 12 digits, the last two are the first ten mod 97
 * (97 when 0). Returns the canonical +++123/4567/89012+++ form, or null.
 */
export function structuredCommunication(text: string): string | null {
  const m = text.match(/(?:\+\+\+|\*\*\*)?\s*(\d{3})\s*\/?\s*(\d{4})\s*\/?\s*(\d{5})\s*(?:\+\+\+|\*\*\*)?/)
  if (!m) return null
  const digits = m[1]! + m[2]! + m[3]!
  const check = Number(digits.slice(0, 10)) % 97 || 97
  if (check !== Number(digits.slice(10))) return null
  return `+++${m[1]}/${m[2]}/${m[3]}+++`
}

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * A bank reference only when it identifies the transaction. Banks put a placeholder on payments that
 * are still pending (Hello bank!: "2026-", the number follows once booked); that counts as none.
 */
export function realReference(text: string | null | undefined): string | null {
  const s = (text ?? '').trim()
  if (!s || /^[-0\s./]*$/.test(s)) return null
  // Only a year, with or without a separator: the number is still to come.
  if (/^(19|20)\d{2}[-/.]?$/.test(s)) return null
  return s
}

export function normalizeRows(rawRows: string[][], mapping: CsvMapping, accountCurrency = 'EUR'): CleanRow[] {
  const c = mapping.columns
  const data = rawRows.slice(mapping.headerRow + 1)
  return data.map((raw, index) => {
    const issues: RowIssue[] = []
    const get = (i: number | undefined): string => (i === undefined ? '' : clean(raw[i]))

    const bookingDate = parseDate(get(c.bookingDate), mapping.dateOrder)
    if (!bookingDate) issues.push('date_invalid')
    const valueDate = c.valueDate !== undefined ? parseDate(get(c.valueDate), mapping.dateOrder) : null

    let amountCents: number | null
    if (c.amount !== undefined) amountCents = parseAmount(get(c.amount), mapping.decimal)
    else {
      const debit = get(c.debit) ? parseAmount(get(c.debit), mapping.decimal) : 0
      const credit = get(c.credit) ? parseAmount(get(c.credit), mapping.decimal) : 0
      amountCents = debit === null || credit === null ? null : (credit ?? 0) - Math.abs(debit ?? 0)
    }
    if (amountCents !== null && mapping.invertSign) amountCents = -amountCents
    if (amountCents === null) issues.push('amount_invalid')
    else if (amountCents === 0) issues.push('amount_zero')

    const currency = get(c.currency).toUpperCase() || null
    if (currency && /^[A-Z]{3}$/.test(currency) && currency !== accountCurrency) issues.push('currency_other')

    const status = get(c.status)
    if (status && /weiger|refus|reject|annul|cancel|declin/i.test(status)) issues.push('status_refused')

    const descParts = [...new Set(c.description.map(get).filter(Boolean))]
    let communication = get(c.communication) || null
    const structured = structuredCommunication(communication ?? '') ?? structuredCommunication(descParts.join(' '))
    if (structured) communication = structured

    const ibanRaw = get(c.counterpartyIban).replace(/\s+/g, '').toUpperCase()
    return {
      index,
      line: mapping.headerRow + index + 2,
      bookingDate,
      valueDate,
      amountCents,
      currency,
      description: descParts.join(' · ') || get(c.counterpartyName) || communication || '',
      counterpartyName: get(c.counterpartyName) || null,
      counterpartyIban: /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(ibanRaw) ? ibanRaw : ibanRaw || null,
      communication,
      bankReference: realReference(get(c.bankReference)),
      balanceCents: c.balance !== undefined && get(c.balance) ? parseAmount(get(c.balance), mapping.decimal) : null,
      issues,
      raw
    }
  })
}
