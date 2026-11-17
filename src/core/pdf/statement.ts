/**
 * Reads the table of a bank statement out of PDF lines and returns it as a plain grid of text (header
 * row first), the way a CSV file would be read, so the normal import does the rest (columns, dates,
 * number formats, debit/credit, duplicates). Amounts are never computed here: the grid only holds
 * text that is in the PDF (a missing year is the one thing filled in, from the statement period).
 */
import { parseAmount } from '@shared/amount'
import { findIbans, maskIban } from '@shared/iban'
import type { Reconciliation } from '@shared/types'
import { detectDecimal, headerField, scoreHeaderRow } from '../csv/mapping'
import { parseDate } from '../csv/normalize'
import type { PdfCell, PdfLine } from './lines'

export interface StatementPeriod {
  from: string | null
  to: string | null
}

export interface StatementBalances {
  opening: number | null
  closing: number | null
}

/** Remarks about the statement, as codes the screen words in the person's language. */
export type StatementNote = { code: 'other_account'; iban: string } | { code: 'dates_without_year' }

export interface StatementRead {
  /** Header row first; empty when no table of transactions was found. */
  grid: string[][]
  headerFound: boolean
  balances: StatementBalances
  period: StatementPeriod
  notes: StatementNote[]
  /** Lines inside the table that are neither a transaction nor part of one (page numbers, footers). */
  droppedLines: number
}

/** Text without accents or capitals, punctuation as single spaces. */
const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const lower = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// ---------------------------------------------------------------------------------------- dates

function parseAny(text: string): string | null {
  return parseDate(text, 'DMY') ?? parseDate(text, 'MDY') ?? parseDate(text, 'YMD')
}

const YEARLESS_NUMBER = /^(\d{1,2})([./-])(\d{1,2})[./-]?$/
const YEARLESS_NAMED = /^(?:\d{1,2}\.?\s?[A-Za-zÀ-ÿ]{3,9}|[A-Za-zÀ-ÿ]{3,9}\.?\s\d{1,2})\.?$/

/** A date written without a year: how to write it with one, and its month. Null for anything else. */
function yearless(dateText: string): { withYear: (year: number) => string; month: number } | null {
  const text = dateText.trim()
  const number = YEARLESS_NUMBER.exec(text)
  if (!number && !YEARLESS_NAMED.test(text)) return null
  const body = text.replace(/[./-]$/, '')
  const withYear = (year: number): string => (number ? `${body}${number[2]}${year}` : `${body} ${year}`)
  const probe = parseAny(withYear(2000))
  return probe ? { withYear, month: Number(probe.slice(5, 7)) } : null
}

/**
 * Adds the year to a date written without one ("03/11", "03 NOV"), from the statement period: the
 * year of the period's end, or the year before when the month is after the end's month (a statement
 * from December to January). Text that has a year, or is no date, is returned as it is.
 */
export function completeYear(dateText: string, period: StatementPeriod): string {
  const parts = yearless(dateText)
  const end = period.to ?? period.from
  if (!parts || !end) return dateText
  const [endYear, endMonth] = end.split('-').map(Number) as [number, number]
  // Only a start is known: the statement runs forward from it.
  const year = period.to ? (parts.month > endMonth ? endYear - 1 : endYear) : parts.month < endMonth ? endYear + 1 : endYear
  return parts.withYear(year)
}

/** The date text of a cell with its year filled in, or null when the cell is no date. */
function dateOf(text: string, period: StatementPeriod): string | null {
  const full = completeYear(text, period)
  return parseAny(full) ? full : null
}

const DATE = String.raw`(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s?[a-z]{3,9}\.?\s?\d{2,4}|[a-z]{3,9}\.?\s\d{1,2},?\s\d{4})`
const UP_TO = String.raw`(?:to|au|bis|tot|t\/m|hasta|ate)`
const PERIOD_WITH_PREFIX = new RegExp(String.raw`(?:from|du|vom|van|desde|del?|periode|period|periodo|zeitraum|von|between|entre)\s*:?\s*${DATE}\s*(?:${UP_TO}|a|al|and|et|und|en|y|e|-|–|—)\s*${DATE}`)
const PERIOD_WITHOUT_PREFIX = new RegExp(`${DATE}\\s*${UP_TO}\\s*${DATE}`)

function periodOf(text: string): StatementPeriod | null {
  const m = PERIOD_WITH_PREFIX.exec(text) ?? PERIOD_WITHOUT_PREFIX.exec(text)
  if (!m) return null
  const [a, b] = [m[1]!, m[2]!]
  // Day first, month first or year first: the order that puts the start before the end.
  for (const order of ['DMY', 'MDY', 'YMD'] as const) {
    const from = parseDate(a, order)
    const to = parseDate(b, order)
    if (from && to && from <= to) return { from, to }
  }
  return null
}

// ------------------------------------------------------------------------------------ balances

const OPENING = [
  'opening balance', 'starting balance', 'beginning balance', 'previous balance', 'balance at start', 'beginsaldo', 'begin saldo', 'oud saldo', 'vorig saldo', 'saldo vorig afschrift', 'saldo vorige',
  'solde precedent', 'solde initial', 'solde de depart', 'ancien solde', 'solde debut', 'alter kontostand', 'anfangssaldo', 'anfangsbestand', 'saldo anterior', 'saldo inicial', 'saldo anteriore', 'saldo iniziale'
]
const CLOSING = [
  'closing balance', 'ending balance', 'final balance', 'new balance', 'balance at end', 'eindsaldo', 'eind saldo', 'nieuw saldo', 'slotsaldo', 'solde final', 'nouveau solde', 'solde fin', 'solde de cloture',
  'neuer kontostand', 'endsaldo', 'schlusssaldo', 'saldo final', 'saldo actual', 'saldo atual', 'saldo nuevo', 'saldo finale'
]
/** Carry-forward lines at a page's end and start: neither a transaction nor a statement balance. */
const CARRY_PHRASES = ['brought forward', 'carried forward', 'carry forward', 'balance forward', 'a reporter', 'suma y sigue', 'over te dragen', 'a transportar', 'saldo transportado']
/** Words that are carry-forward lines only when they are all the line says ("Ubertrag auf Sparkonto" is a payment). */
const CARRY_WORDS = ['transport', 'transporte', 'report', 'ubertrag', 'overdracht']

const hasPhrase = (folded: string, phrase: string): boolean => ` ${folded} `.includes(` ${phrase} `)

const DATE_CELL = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/
const AMOUNT_CELL = /^[-+(]?\s*(?:[A-Z]{3}\s*|[€$£]\s*)?[-+]?\d[\d., '’]*[.,]\d{2}\s*\)?-?(?:\s*(?:CR|DR))?(?:\s*[A-Z]{3})?$/i
const AMOUNT_AT_END = /(?:^|\s)([-+(]?\s*(?:[A-Z]{3}\s*|[€$£]\s*)?[-+]?\d{1,3}(?:[., '’]\d{3})*[.,]\d{2}\s*\)?-?(?:\s*(?:CR|DR))?)$/i

const isAmountText = (text: string): boolean => AMOUNT_CELL.test(text.trim()) && !DATE_CELL.test(text.trim())

interface KeywordLine {
  carry: boolean
  found: { kind: 'opening' | 'closing'; amountText: string | null }[]
}

/** What a line says about balances, or null when it holds no balance keyword. */
function keywordLine(line: PdfLine): KeywordLine | null {
  // A carry-forward line: all that is left of it, without dates and numbers, is the keyword.
  const label = fold(
    line.cells
      .filter((c) => !isAmountText(c.text) && !DATE_CELL.test(c.text))
      .map((c) => c.text)
      .join(' ')
  )
    .split(' ')
    .filter((w) => !/^\d+$/.test(w))
    .join(' ')
  const dated = line.cells.some((c) => parseAny(c.text))
  if ((!dated && CARRY_WORDS.includes(label)) || CARRY_PHRASES.some((p) => hasPhrase(label, p))) return { carry: true, found: [] }

  const found: KeywordLine['found'] = []
  let segment: { kind: 'opening' | 'closing'; cells: string[] } | null = null
  const close = (): void => {
    if (!segment) return
    const cells = segment.cells
    const whole = [...cells].reverse().find(isAmountText)
    // "Opening balance 1,000.00" in one cell.
    const trailing = AMOUNT_AT_END.exec(cells[0]!)?.[1]
    found.push({ kind: segment.kind, amountText: whole ?? trailing ?? null })
    segment = null
  }
  for (const cell of line.cells) {
    const f = fold(cell.text)
    const kind = OPENING.some((k) => hasPhrase(f, k)) ? 'opening' : CLOSING.some((k) => hasPhrase(f, k)) ? 'closing' : null
    if (kind) {
      close()
      segment = { kind, cells: [cell.text] }
    } else segment?.cells.push(cell.text)
  }
  close()
  return found.length ? { carry: false, found } : null
}

// --------------------------------------------------------------------------------------- columns

/** Columns that hold dates, amounts and the like: a continuation of a description has nothing in them. */
const STRUCTURED = new Set(['bookingDate', 'valueDate', 'amount', 'debit', 'credit', 'direction', 'balance', 'currency', 'status'])

/** The column a cell belongs to: the one whose header it overlaps most, else the nearest. */
function columnOf(cell: PdfCell, columns: PdfCell[]): number {
  let best = 0
  let bestScore = -Infinity
  columns.forEach((col, i) => {
    const score = Math.min(cell.x1, col.x1) - Math.max(cell.x0, col.x0)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return best
}

const cellTexts = (line: PdfLine): string[] => line.cells.map((c) => c.text)

export function isHeaderLine(line: PdfLine): boolean {
  const texts = cellTexts(line)
  if (texts.length < 2 || scoreHeaderRow(texts) < 2) return false
  return texts.some((t) => ['bookingDate', 'valueDate'].includes(headerField(t) ?? ''))
}

const sameHeader = (a: PdfLine, b: PdfLine): boolean => a.cells.length === b.cells.length && a.cells.every((c, i) => fold(c.text) === fold(b.cells[i]!.text))

/** The middle value, the lower one of the two for an even count (the usual step between lines, not a gap before a footer). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0
}

// ------------------------------------------------------------------------- page headers and footers

/** A line this close to the top or bottom edge (as a share of the page) can be a header or footer. */
const MARGIN = 0.12

/**
 * Lines that the pages repeat in their margins at the same height (a title, an address, "page 2 of 7",
 * the print date): the text is the same once its numbers are ignored (page 2 of 7, page 12 of 71). Lines with an amount never count.
 */
function marginLines(lines: PdfLine[]): Set<number> {
  const pages = new Set(lines.map((l) => l.page)).size
  const seen = new Map<string, { pages: Set<number>; ids: number[] }>()
  for (const line of lines) {
    const height = line.pageHeight
    if (!height || Math.min(line.y, height - line.y) > height * MARGIN || line.cells.some((c) => isAmountText(c.text))) continue
    const key = `${Math.round(line.y)}|${line.cells.map((c) => c.text.replace(/\d+/g, '0')).join('|')}`
    const entry = seen.get(key) ?? { pages: new Set<number>(), ids: [] }
    entry.pages.add(line.page)
    entry.ids.push(line.id)
    seen.set(key, entry)
  }
  const found = new Set<number>()
  for (const entry of seen.values()) if (entry.pages.size >= Math.max(2, Math.ceil(pages / 2))) entry.ids.forEach((id) => found.add(id))
  return found
}

// ------------------------------------------------------------------------------------ block layouts

/** A date as one cell, with or without a year. */
const isDateCell = (text: string): boolean => DATE_CELL.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{2,4}$/.test(text) || yearless(text) !== null

export const isMonthName = (text: string): boolean => /^[A-Za-zÀ-ÿ]{3,9}\.?$/.test(text) && parseAny(`1 ${text} 2000`) !== null

const FULL_DATE = /(?<!\d)(\d{1,2}[./-]\d{1,2}[./-]\d{4})(?!\d)/g
const SIGNED = /^[-+(]|-$|\b(?:CR|DR)\b/i

/** The amounts at the end of a line (up to two, left to right) and how many cells they take; a currency code in a cell of its own goes with its amount. */
function trailingAmounts(line: PdfLine): { text: string; cells: number }[] {
  const found: { text: string; cells: number }[] = []
  let end = line.cells.length
  while (end > 0 && found.length < 2) {
    const last = line.cells[end - 1]!
    const before = line.cells[end - 2]
    if (/^[A-Z]{3}$/.test(last.text) && before && isAmountText(before.text)) {
      found.unshift({ text: `${before.text} ${last.text}`, cells: 2 })
      end -= 2
    } else if (isAmountText(last.text)) {
      found.unshift({ text: last.text, cells: 1 })
      end -= 1
    } else break
  }
  return found
}

interface Block {
  lines: PdfLine[]
  amounts: { text: string; cells: number }[]
}

/** The date a block prints: one cell, or a day with its month name in another (as "17" above "NOV"). Null when there is none. */
function blockDate(block: Block, period: StatementPeriod): { date: string | null; used: Set<PdfCell>; yearless: boolean } {
  const cells = block.lines.flatMap((l) => l.cells.map((c, i) => ({ cell: c, first: i === 0 })))
  const whole = cells.find((c) => isDateCell(c.cell.text))
  if (whole) {
    const date = dateOf(whole.cell.text, period)
    return { date, used: new Set([whole.cell]), yearless: date === null && yearless(whole.cell.text) !== null }
  }
  const day = cells.find((c) => c.first && /^\d{1,2}$/.test(c.cell.text) && Number(c.cell.text) >= 1 && Number(c.cell.text) <= 31)
  const month = day && cells.slice(cells.indexOf(day) + 1).find((c) => isMonthName(c.cell.text))
  if (!day || !month) return { date: null, used: new Set(), yearless: false }
  const date = dateOf(`${day.cell.text} ${month.cell.text}`, period)
  return { date, used: new Set([day.cell, month.cell]), yearless: date === null }
}

/**
 * Statements that are not a table but a list of blocks (a bank app's printout): each transaction
 * starts on the line that ends with its amount, with its date, in one piece or as a day with its month
 * below it, and its description around that, over a few lines. The grid gets a header made up here
 * (Date, Description, Amount); every cell below it is text from the PDF. Null when it doesn't look like that.
 */
function readBlocks(lines: PdfLine[], keywords: (KeywordLine | null)[], printed: string, period: StatementPeriod, notes: StatementNote[], ownIban: string | null): StatementRead | null {
  const step = median(lines.flatMap((l, i) => (i > 0 && lines[i - 1]!.page === l.page && lines[i - 1]!.y > l.y ? [lines[i - 1]!.y - l.y] : [])))
  const blocks: Block[] = []
  const rank = new Map<number, number>()
  lines.forEach((l, i) => rank.set(l.id, i > 0 && lines[i - 1]!.page === l.page ? rank.get(lines[i - 1]!.id)! + 1 : 0))

  // Without a printed period, the latest full date outside the blocks (the print date) stands for the end of the statement.
  let yearPeriod = period
  if (!period.from && !period.to) {
    const dates = [...printed.matchAll(FULL_DATE)].flatMap((m) => parseAny(m[1]!) ?? [])
    const latest = dates.sort().at(-1)
    if (latest) yearPeriod = { from: null, to: latest }
  }

  let current: Block | null = null
  let dropped = 0
  for (const [i, line] of lines.entries()) {
    const amounts = keywords[i] ? [] : trailingAmounts(line)
    if (amounts.length) {
      current = { lines: [line], amounts }
      blocks.push(current)
      continue
    }
    const last: PdfLine | undefined = current?.lines.at(-1)
    // A line below the block belongs to it when it is close; at the top of the next page, when the block has no date yet.
    if (current && last && (last.page === line.page ? last.y - line.y <= step * 1.6 : rank.get(line.id)! < 3 && blockDate(current, yearPeriod).date === null)) {
      current.lines.push(line)
    } else {
      if (blocks.length) dropped++
      current = null
    }
  }

  const read = blocks.map((block) => ({ block, ...blockDate(block, yearPeriod) }))
  const dated = read.filter((b) => b.date !== null)
  const amountCounts = new Set(dated.map((b) => b.block.amounts.length))
  const balance = amountCounts.size === 1 && amountCounts.has(2)
  // Without signs the amounts could be money in or out: not worth a guess.
  const signed = dated.some((b) => SIGNED.test(b.block.amounts.at(balance ? -2 : -1)!.text))
  if (dated.length < 2 || dated.length * 2 < blocks.length || !signed) return null

  const rows = dated.map(({ block, date, used }) => {
    const kept = block.amounts.slice(balance ? -2 : -1)
    const start = block.lines[0]!.cells
    const amountCells = new Set(start.slice(start.length - kept.reduce((n, a) => n + a.cells, 0)))
    const description = block.lines.flatMap((l) => l.cells.filter((c) => !used.has(c) && !amountCells.has(c)).map((c) => c.text))
    return [date!, description.join(' '), ...kept.map((a) => a.text)]
  })
  const fields = balance ? ['bookingDate', 'description', 'amount', 'balance'] : ['bookingDate', 'description', 'amount']
  const header = balance ? ['Date', 'Description', 'Amount', 'Balance'] : ['Date', 'Description', 'Amount']
  const kept = new Set(dated.map((b) => b.block))
  const droppedLines = dropped + blocks.filter((b) => !kept.has(b)).reduce((n, b) => n + b.lines.length, 0)
  if (read.some((b) => b.yearless)) notes.push({ code: 'dates_without_year' })
  const result: StatementRead = { grid: withIbans([header, ...rows], fields, ownIban), headerFound: true, balances: { opening: null, closing: null }, period, notes, droppedLines }
  return withBalances(result, keywords, rows.flatMap((r) => r.slice(2)))
}

// ------------------------------------------------------------------------------------- the read

export function readStatement(allLines: PdfLine[], ownIban?: string | null): StatementRead {
  const notes: StatementNote[] = []
  const margins = marginLines(allLines)
  const lines = margins.size ? allLines.filter((l) => !margins.has(l.id)) : allLines
  const headerIndex = lines.findIndex(isHeaderLine)
  const headerFound = headerIndex >= 0
  // Everything above the table, headers in the margins too.
  const before = headerFound ? allLines.filter((l) => l.id < lines[headerIndex]!.id) : allLines

  // The statement period, from the first line that prints one.
  let period: StatementPeriod = { from: null, to: null }
  for (const line of allLines) {
    const found = periodOf(lower(cellTexts(line).join(' ')))
    if (found) {
      period = found
      break
    }
  }
  // Without a printed period, the year that is printed above the table stands for the whole statement.
  let yearPeriod = period
  if (!period.from && !period.to) {
    const years = new Map<string, number>()
    for (const m of before.map((l) => cellTexts(l).join(' ')).join(' ').matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)) years.set(m[1]!, (years.get(m[1]!) ?? 0) + 1)
    const year = [...years].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (year) yearPeriod = { from: null, to: `${year}-12-31` }
  }

  // Another account's statement: the account's own number is not printed above the table, another is.
  if (ownIban) {
    const own = ownIban.replace(/\s/g, '').toUpperCase()
    const printed = findIbans(before.map((l) => cellTexts(l).join(' ')).join(' '))
    if (printed.length && !printed.includes(own)) notes.push({ code: 'other_account', iban: maskIban(printed[0]!) })
  }

  const keywords = lines.map(keywordLine)
  // A table when there is a header with rows under it, else a list of blocks, else nothing.
  const result = (table: StatementRead): StatementRead => {
    if (table.grid.length) return table
    const outside = allLines.filter((l) => margins.has(l.id) || l.id < (lines.find((x, i) => !keywords[i] && trailingAmounts(x).length)?.id ?? 0))
    const printed = outside.map((l) => cellTexts(l).join(' ')).join('\n')
    return readBlocks(lines, keywords, printed, period, notes.filter((n) => n.code === 'other_account'), ownIban ?? null) ?? table
  }
  if (!headerFound) return result(withBalances({ grid: [], headerFound, balances: { opening: null, closing: null }, period, notes, droppedLines: 0 }, keywords, []))

  const header = lines[headerIndex]!
  const fields = header.cells.map((c) => headerField(c.text))
  const dateColumn = [fields.indexOf('bookingDate'), fields.indexOf('valueDate'), 0].find((i) => i >= 0)!
  const step = median(
    lines.slice(headerIndex).flatMap((l, i, all) => (i > 0 && all[i - 1]!.page === l.page && all[i - 1]!.y > l.y ? [all[i - 1]!.y - l.y] : []))
  )

  let columns: PdfCell[] = header.cells
  const headerTexts = header.cells.map((c) => c.text)
  /** A header label that goes on in the line below it ("Volgnum" / "mer"). */
  let afterHeader: { y: number; page: number; first: boolean } | null = null
  const rows: string[][] = []
  let current: { row: string[]; page: number; y: number } | null = null
  let dropped = 0
  let needsYear = false

  for (let i = headerIndex; i < lines.length; i++) {
    const line = lines[i]!
    if (i === headerIndex || (isHeaderLine(line) && sameHeader(line, header))) {
      // The columns may sit elsewhere on this page.
      columns = line.cells
      current = null
      afterHeader = { y: line.y, page: line.page, first: i === headerIndex }
      continue
    }
    if (keywords[i]) {
      current = null
      continue
    }
    const placed: string[] = columns.map(() => '')
    for (const cell of line.cells) {
      const col = columnOf(cell, columns)
      placed[col] = placed[col] ? `${placed[col]} ${cell.text}` : cell.text
    }
    const date = dateOf(placed[dateColumn]!, yearPeriod)
    if (date !== null) {
      placed[dateColumn] = date
      const valueColumn = fields.indexOf('valueDate')
      if (valueColumn >= 0 && valueColumn !== dateColumn) placed[valueColumn] = dateOf(placed[valueColumn]!, yearPeriod) ?? placed[valueColumn]!
      rows.push(placed)
      current = { row: placed, page: line.page, y: line.y }
      afterHeader = null
      continue
    }
    if (afterHeader && afterHeader.page === line.page && (step === 0 || afterHeader.y - line.y <= step * 1.6) && !line.cells.some((c) => isAmountText(c.text))) {
      if (afterHeader.first) placed.forEach((text, col) => text && (headerTexts[col] = `${headerTexts[col]} ${text}`))
      afterHeader.y = line.y
      continue
    }
    afterHeader = null
    if (!yearPeriod.from && !yearPeriod.to && yearless(placed[dateColumn]!)) needsYear = true
    // A line below a transaction, in the description columns only and close to it, belongs to it.
    const inStructured = placed.some((text, col) => text && STRUCTURED.has(fields[col] ?? ''))
    if (current && current.page === line.page && !inStructured && (step === 0 || current.y - line.y <= step * 1.6)) {
      placed.forEach((text, col) => {
        if (text) current!.row[col] = current!.row[col] ? `${current!.row[col]} ${text}` : text
      })
      current.y = line.y
      continue
    }
    dropped++
    current = null
  }
  if (needsYear) notes.push({ code: 'dates_without_year' })

  const grid = rows.length ? withIbans([headerTexts, ...rows], fields, ownIban ?? null) : []
  const read: StatementRead = { grid, headerFound, balances: { opening: null, closing: null }, period, notes, droppedLines: dropped }
  const amountColumns = fields.flatMap((f, i) => (f === 'amount' || f === 'debit' || f === 'credit' || f === 'balance' ? [i] : []))
  return result(withBalances(read, keywords, rows.flatMap((r) => amountColumns.map((i) => r[i]!).filter(Boolean))))
}

/** Reads the balance lines with the decimal mark the table's own numbers use. */
function withBalances(read: StatementRead, keywords: (KeywordLine | null)[], numbers: string[]): StatementRead {
  const found = keywords.flatMap((k) => k?.found ?? [])
  const decimal = detectDecimal([...numbers, ...found.flatMap((f) => (f.amountText ? [f.amountText] : []))])
  const amount = (kind: 'opening' | 'closing'): number | null => {
    const values = found.filter((f) => f.kind === kind && f.amountText !== null).map((f) => parseAmount(f.amountText!, decimal))
    // The first opening balance and the last closing balance are the statement's.
    const value = kind === 'opening' ? values.find((v) => v !== null) : [...values].reverse().find((v) => v !== null)
    return value ?? null
  }
  return { ...read, balances: { opening: amount('opening'), closing: amount('closing') } }
}

/** An IBAN other than the account's own in a row's text gets a column of its own, unless the table has one. */
function withIbans(grid: string[][], fields: (string | null)[], ownIban: string | null): string[][] {
  if (fields.includes('counterpartyIban')) return grid
  const own = ownIban?.replace(/\s/g, '').toUpperCase()
  const found = grid.slice(1).map((row) => findIbans(row.join(' ')).find((iban) => iban !== own) ?? '')
  if (!found.some(Boolean)) return grid
  return grid.map((row, i) => [...row, i === 0 ? 'IBAN' : found[i - 1]!])
}

// ------------------------------------------------------------------------------- reconciliation

interface Amounts {
  amountCents: number | null
  balanceCents: number | null
}

/** Rows (in file order) whose running balance doesn't follow from the one before; either direction of the file counts. */
export function runningMismatches(rows: Amounts[], opening: number | null): boolean[] {
  const run = (list: Amounts[]): boolean[] => {
    let expected = opening
    return list.map((r) => {
      if (r.amountCents === null) return false
      if (expected !== null) expected += r.amountCents
      if (r.balanceCents === null) return false
      const wrong = expected !== null && expected !== r.balanceCents
      expected = r.balanceCents
      return wrong
    })
  }
  const forward = run(rows)
  // Newest first: the same walk from the other end.
  const backward = run([...rows].reverse()).reverse()
  const count = (flags: boolean[]): number => flags.filter(Boolean).length
  return count(backward) < count(forward) ? backward : forward
}

/** Whether opening balance plus the rows makes the closing balance, and each running balance follows. */
export function reconcile(rows: Amounts[], balances: StatementBalances): Reconciliation {
  const counted = rows.filter((r) => r.amountCents !== null)
  const sumCents = counted.reduce((t, r) => t + r.amountCents!, 0)
  const { opening, closing } = balances
  return {
    openingCents: opening,
    closingCents: closing,
    sumCents,
    differenceCents: opening !== null && closing !== null ? closing - (opening + sumCents) : null,
    rowsChecked: counted.length,
    runningMismatches: runningMismatches(counted, opening).filter(Boolean).length
  }
}
