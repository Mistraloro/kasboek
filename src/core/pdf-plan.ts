/**
 * Reading a PDF statement with the assistant, without trusting it. Only the statement's text goes out
 * (masked, as lines with their positions); the assistant answers with which lines form each
 * transaction and the date, amount, balance and counterparty exactly as the text writes them. Code
 * checks that every one of those strings is really in the row's own lines and reads the amounts
 * from the PDF's text itself, so the assistant never types an amount. No Electron or network here.
 */
import { z } from 'zod'
import { parseAmount } from '@shared/amount'
import { findIbans, maskIban, maskNumbers } from '@shared/iban'
import type { ImportMapping } from '@shared/types'
import { parseJsonAnswer } from './assist-plan'
import { detectDateOrder, detectDecimal } from './csv/mapping'
import { parseDate } from './csv/normalize'
import type { PdfLine } from './pdf/lines'
import { completeYear, isHeaderLine, isMonthName, type StatementBalances, type StatementPeriod } from './pdf/statement'

/** What the model must return (also sent as the JSON schema). */
export const PdfRowsPlan = z.object({
  rows: z.array(
    z.object({
      lines: z.array(z.number().int()).describe('Ids of the lines (the number after L) that make up this transaction, e.g. [12, 13].'),
      date: z.string().describe('The transaction date, copied exactly as written in those lines.'),
      valueDate: z.string().nullable().describe('The value date, copied exactly as written, or null if the lines have none.'),
      amount: z.string().describe('The transaction amount, copied exactly as written (with any minus sign, brackets, DR or CR), not the balance.'),
      direction: z.enum(['in', 'out']).nullable().describe('Whether the money came in or went out, only when the text of the lines shows it without a sign (a Debit or Credit column, for instance); else null.'),
      balance: z.string().nullable().describe('The running balance after this transaction, copied exactly as written, or null if the lines have none.'),
      counterparty: z.string().nullable().describe('Who was paid or who paid, copied exactly as written in the lines, or null.')
    })
  ),
  openingBalance: z.string().nullable().describe('The statement’s opening balance, copied exactly as written, or null.'),
  closingBalance: z.string().nullable().describe('The statement’s closing balance, copied exactly as written, or null.'),
  notes: z.array(z.string()).describe('Up to 3 short remarks for the person, e.g. lines you could not place.')
})
export type PdfRowsPlan = z.infer<typeof PdfRowsPlan>

/**
 * Reads the model's answer, forgivingly: a code fence around it is ignored and a single bad row is
 * dropped instead of throwing the whole answer away.
 */
export function parsePdfPlan(text: string, name: string): PdfRowsPlan {
  const raw = parseJsonAnswer(text, name)
  const strict = PdfRowsPlan.safeParse(raw)
  if (strict.success) return strict.data
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const Row = PdfRowsPlan.shape.rows.element
  const rows = (Array.isArray(o['rows']) ? o['rows'] : []).flatMap((r: unknown) => {
    const given = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    // Line numbers written as text ("12") are accepted; a left-out field counts as null.
    const lines = Array.isArray(given['lines']) ? given['lines'].map((n) => (typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n)) : given['lines']
    const parsed = Row.safeParse({ valueDate: null, direction: null, balance: null, counterparty: null, ...given, lines })
    return parsed.success ? [parsed.data] : []
  })
  const text1 = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    rows,
    openingBalance: text1(o['openingBalance']),
    closingBalance: text1(o['closingBalance']),
    notes: (Array.isArray(o['notes']) ? o['notes'] : []).filter((n): n is string => typeof n === 'string')
  }
}

// ------------------------------------------------------------------------------------- masked text

/** A line of the statement as it is sent: numbers masked, with its position. */
export interface MaskedLine {
  id: number
  page: number
  /** `L12 p2 | x60 03/11 | x140 DESCRIPTION | x510 45,10-` */
  text: string
  /** The cells' text only (masked), the text a returned string must be found in. */
  plain: string
}

/** A line is cut after this many characters; nothing in a transaction needs more. */
const MAX_LINE_CHARS = 1000

const cellText = (line: PdfLine): string => line.cells.map((c) => c.text).join(' ')

/** The first line of the table of transactions (its header row), or null when the text has none. */
export function tableStart(lines: PdfLine[]): number | null {
  return lines.find(isHeaderLine)?.id ?? null
}

/** A date as statements write it: 2026-11-03, 03/11/2026, 03.11.26, 03/11, 03.11. or a day with a month name. */
const DATE_LIKE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}([/.-])\d{1,2}\1\d{2,4}\b|\b\d{1,2}\/\d{1,2}\b(?!\/)|\b\d{1,2}\.\d{1,2}\.(?!\d)/
const AMOUNT_LIKE = /\d[\d.,' ]*[.,]\d{2}(?!\d)/

/** Whether a line has a date and an amount, as a transaction does and a name or address does not. */
function looksLikeTransaction(line: PdfLine): boolean {
  const text = cellText(line)
  const dateless = text.replace(DATE_LIKE, ' ')
  const hasDate = dateless !== text || (tokens(text).some(isMonthName) && /(?:^|\s)\d{1,2}(?:\s|$)/.test(text))
  return hasDate && AMOUNT_LIKE.test(dateless)
}

/**
 * The first line to send: the table's header, or, when there is none, the first line with a date and
 * an amount, so that the holder's name, address and other free text above the transactions never go
 * out. Null when there is neither: then there is nothing to read and nothing is sent.
 */
export function firstLineSent(lines: PdfLine[]): number | null {
  return tableStart(lines) ?? lines.find(looksLikeTransaction)?.id ?? null
}

/** An e-mail address, or a phone number written with a + or 00 prefix. Cheap and not exhaustive. */
const EMAIL = /[^\s@<>()|]+@[^\s@<>()|]+\.[^\s@<>()|]+/g
const PHONE = /(?:\+|\b00)\d[\d ./()-]{6,}\d/g
const maskContacts = (text: string): string => text.replace(EMAIL, '…@…').replace(PHONE, '…phone…')

/**
 * The lines as they are sent: IBANs, runs of 13 or more digits, e-mail addresses and phone numbers
 * masked, and, with `skipBefore` (the first line to send), everything above it left out.
 */
export function maskedLines(lines: PdfLine[], opts: { skipBefore?: number | null } = {}): MaskedLine[] {
  const skip = opts.skipBefore ?? null
  return lines
    .filter((l) => skip === null || l.id >= skip)
    .map((l) => {
      const cells = l.cells.map((c) => ({ x: Math.round(c.x0), text: maskNumbers(maskContacts(c.text)).slice(0, MAX_LINE_CHARS) }))
      // An account number cut over two cells by wide spacing is only recognised as a whole: then the line is sent as one piece.
      const joined = cells.map((c) => c.text).join(' ')
      const whole = maskIban(joined)
      const pieces = whole === joined ? cells : [{ x: cells[0]?.x ?? 0, text: whole.slice(0, MAX_LINE_CHARS) }]
      return {
        id: l.id,
        page: l.page,
        text: [`L${l.id} p${l.page}`, ...pieces.map((c) => `x${c.x} ${c.text}`)].join(' | '),
        plain: pieces.map((c) => c.text).join(' ')
      }
    })
}

/**
 * Everything that is sent for a statement, masked: from the table's header (or else the first
 * transaction-like line) onward. Empty when there is no such line. The preview and the calls to the
 * assistant are both made from this one list.
 */
export const linesToSend = (lines: PdfLine[]): MaskedLine[] => {
  const start = firstLineSent(lines)
  return start === null ? [] : maskedLines(lines, { skipBefore: start })
}

/** The text the person is shown before agreeing: the lines of every part, as they are sent. */
export const previewText = (masked: MaskedLine[]): string => masked.map((m) => m.text).join('\n')

/** At most this many pages and characters go to the assistant in one call. */
export const MAX_PART_PAGES = 4
export const MAX_PART_CHARS = 40_000
/** And this many lines: a transaction takes about 30 tokens of answer, and one answer must fit in about 6000. */
export const MAX_PART_LINES = 180
/** A part of this many lines or fewer (about 5 transactions) is not split further. */
export const MIN_SPLIT_LINES = 10
/** The last lines of the part before are repeated, marked as context, so a transaction cut by a part boundary can be understood. */
export const CONTEXT_LINES = 3
/** Longer statements are not read by the assistant. */
export const MAX_AI_PAGES = 40

export interface PdfPart {
  n: number
  of: number
  context: MaskedLine[]
  own: MaskedLine[]
}

export const pagesOf = (masked: MaskedLine[]): number => new Set(masked.map((m) => m.page)).size

/** Splits the lines into parts of at most 4 pages and 40,000 characters. */
export function splitParts(masked: MaskedLine[]): PdfPart[] {
  const groups: MaskedLine[][] = []
  let current: MaskedLine[] = []
  let pages = new Set<number>()
  let chars = 0
  for (const m of masked) {
    const size = m.text.length + 1
    if (current.length && (chars + size > MAX_PART_CHARS || current.length >= MAX_PART_LINES || (!pages.has(m.page) && pages.size >= MAX_PART_PAGES))) {
      groups.push(current)
      current = []
      pages = new Set()
      chars = 0
    }
    current.push(m)
    pages.add(m.page)
    chars += size
  }
  if (current.length) groups.push(current)
  return groups.map((own, i) => ({ n: i + 1, of: groups.length, context: i > 0 ? groups[i - 1]!.slice(-CONTEXT_LINES) : [], own }))
}

/**
 * A part in two halves, for when its answer did not fit; null when it is small enough. The cut is
 * made at the line nearest the middle that starts with a date, so a transaction stays in one half;
 * the second half gets the last lines of the first as context.
 */
export function splitPart(part: PdfPart): [PdfPart, PdfPart] | null {
  const lines = part.own
  if (lines.length <= MIN_SPLIT_LINES) return null
  const mid = Math.floor(lines.length / 2)
  const starts = (i: number): boolean => /\|\s*x\d+ \d{1,2}[/.-]\d{1,2}/.test(lines[i]!.text)
  let cut = mid
  for (let d = 0; d < mid - MIN_SPLIT_LINES / 2; d++) {
    if (starts(mid + d)) cut = mid + d
    else if (starts(mid - d)) cut = mid - d
    else continue
    break
  }
  const first = lines.slice(0, cut)
  return [
    { ...part, own: first },
    { ...part, context: first.slice(-CONTEXT_LINES), own: lines.slice(cut) }
  ]
}

/** The text a part is sent as. */
export function partText(part: PdfPart): string {
  const head = `Part ${part.n} of ${part.of}.${part.context.length ? ' Lines marked (context only) end the part before: do not use them in any row.' : ''}`
  return [head, '', ...part.context.map((m) => `(context only) ${m.text}`), ...part.own.map((m) => m.text)].join('\n')
}

// ------------------------------------------------------------------------------------ verification

export interface PlanPart {
  /** The lines this part was sent as its own (not as context). */
  own: MaskedLine[]
  plan: PdfRowsPlan
}

export interface RejectedRow {
  /** Index among the data rows of the grid. */
  row: number
  lines: number[]
  reason: string
}

export interface RowsOutcome {
  grid: string[][]
  mapping: ImportMapping
  rejected: RejectedRow[]
  /** Balances from the assistant's answer, each only when it is literally in the text. */
  balances: StatementBalances
  accepted: number
}

export const GRID_HEADER = ['Date', 'Value date', 'Description', 'Counterparty', 'IBAN', 'Amount', 'Balance']

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
const dashes = (s: string): string => s.replace(/[−–—]/g, '-')

/** Whether `needle` is in `hay` as a whole value: a date or amount is not part of a longer number. */
function appears(hay: string, needle: string, kind: 'number' | 'date' | 'text'): boolean {
  const n = norm(needle)
  if (!n) return false
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) {
    if (kind === 'text') return true
    const before = hay[i - 1] ?? ''
    const after = hay.slice(i + n.length, i + n.length + 2)
    const fine = kind === 'number' ? !/[\d.,]/.test(before) && !/^\d/.test(after) : !/\d/.test(before) && !/^(\d|[./-]\d)/.test(after)
    if (fine) return true
  }
  return false
}

const tokens = (s: string): string[] => norm(s).split(' ').filter(Boolean)

/** The positions of `want` among `have`, each as a whole token and in reading order (not necessarily next to each other); null when one is missing. */
function findTokens(have: string[], want: string[]): number[] | null {
  const at: number[] = []
  for (const w of want) {
    const i = have.indexOf(w, (at.at(-1) ?? -1) + 1)
    if (i < 0) return null
    at.push(i)
  }
  return at
}

/**
 * The tokens of a date that a block layout prints in separate cells or lines ("3" above "mars"): a
 * month name with a day, and perhaps a year, each a whole token. Null for anything else.
 */
function splitDate(date: string): string[] | null {
  const want = tokens(date)
  const months = want.filter(isMonthName).length
  return want.length >= 2 && want.length <= 3 && months === 1 && want.every((t) => isMonthName(t) || /^\d{1,4}$/.test(t)) ? want : null
}

const spansCells = (text: string, date: string): boolean => {
  const want = splitDate(date)
  return want !== null && findTokens(tokens(text), want) !== null
}

const CURRENCY = '(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|CAD|AUD|JPY|[€$£¥])'
/** What stands right before an amount: a sign, an opening bracket or DR / CR, and perhaps a currency between it and the number. */
const BEFORE_AMOUNT = new RegExp(`(?:(?<!\\w)([-+])|(\\()|(?<![A-Za-z])(CR|DR)\\s)?(?:${CURRENCY}\\s?)?$`, 'i')
/** What stands right behind an amount: perhaps a currency, then a sign attached to it, a closing bracket or DR / CR. */
const AFTER_AMOUNT = new RegExp(`^(?:\\s?${CURRENCY})?(?:([-+)])(?!\\d)|\\s?(CR|DR)\\b)?`, 'i')

type Polarity = 'neg' | 'pos' | 'none'

/** The number in the assistant's amount string and the sign it carries (minus, brackets or DR count as negative; plus or CR as positive). */
function modelAmount(model: string): { core: string; polarity: Polarity | 'unclear' } | null {
  const m = dashes(norm(model))
  const core = /\d(?:[\d.,' ]*\d)?/.exec(m)?.[0]
  if (!core) return null
  const rest = m.replace(core, ' ')
  const neg = /[-(]|\)|\bDR\b/i.test(rest)
  const pos = /\+|\bCR\b/i.test(rest)
  return { core, polarity: neg && pos ? 'unclear' : neg ? 'neg' : pos ? 'pos' : 'none' }
}

/**
 * The amount as the statement's own text writes it. The number is found in `hay` as a whole value, then
 * the real text around it is read for a sign: minus, plus, brackets, DR or CR, with a currency between
 * them and the number. That sign decides, never the assistant's copy of it: an amount the text signs
 * and the assistant did not is read with the text's sign, one the assistant signed and the text did
 * not is refused. `direction` is for unsigned text only (the caller).
 */
function readAmount(hay: string, model: string): { amount: string; polarity: Polarity; span: string } | { error: string } {
  const given = modelAmount(model)
  const missing = { error: `The amount “${norm(model)}” is not in the text of this row’s lines.` }
  if (!given || given.polarity === 'unclear') return missing
  let found: { amount: string; polarity: Polarity; span: string } | null = null
  let conflict = false
  let seen = false
  const text = dashes(hay)
  for (let i = text.indexOf(given.core); i >= 0 && !found; i = text.indexOf(given.core, i + 1)) {
    const end = i + given.core.length
    if (/[\d.,]/.test(text[i - 1] ?? '') || /^[.,]?\d/.test(text.slice(end, end + 2))) continue
    seen = true
    const left = BEFORE_AMOUNT.exec(text.slice(0, i))!
    const right = AFTER_AMOUNT.exec(text.slice(end))!
    const negs = [left[1] === '-', !!left[2], left[3]?.toUpperCase() === 'DR', right[1] === '-' || right[1] === ')', right[2]?.toUpperCase() === 'DR']
    const nNeg = negs.filter(Boolean).length
    const nPos = [left[1] === '+', left[3]?.toUpperCase() === 'CR', right[1] === '+', right[2]?.toUpperCase() === 'CR'].filter(Boolean).length
    const brackets = !!left[2] || right[1] === ')'
    // Two minus signs would cancel out in the parser, and a minus with a plus is no sign to trust.
    if ((nNeg > 0 && nPos > 0) || nNeg > 2 || (nNeg === 2 && !(left[2] && right[1] === ')'))) {
      conflict = true
      continue
    }
    const polarity: Polarity = nNeg ? 'neg' : nPos ? 'pos' : 'none'
    // The assistant's own sign has to be there in the text too; an unsigned copy takes the text's sign.
    if (given.polarity !== 'none' && given.polarity !== polarity) continue
    const amount = brackets ? `(${given.core})` : left[1] === '-' ? `-${given.core}` : right[1] === '-' ? `${given.core}-` : left[3]?.toUpperCase() === 'DR' || right[2]?.toUpperCase() === 'DR' ? `${given.core} DR` : given.core
    const spanStart = i - (left[0]?.length ?? 0)
    const spanEnd = end + (right[0]?.length ?? 0)
    found = { amount, polarity, span: norm(hay.slice(spanStart, spanEnd)) }
  }
  if (found) return found
  return conflict ? { error: `The sign of the amount “${norm(model)}” is not clear in the text of this row’s lines.` } : seen && given.polarity !== 'none' ? { error: `The amount “${norm(model)}” has a sign that the text of this row’s lines does not have.` } : missing
}

/** Numbers without letters and currency signs, for working out the decimal mark. */
const bare = (s: string): string => s.replace(/[A-Za-z€$£\s]/g, '')

interface Accepted {
  order: number
  ids: number[]
  date: string
  valueDate: string
  amount: string
  balance: string
  counterparty: string
  description: string
  iban: string
}

/**
 * Checks the assistant's rows against the statement and builds the grid of text the normal import
 * reads. A row is accepted only when its lines were sent in its own part and are used by no other
 * row, and its date, value date, amount, balance and counterparty are each in the text of those
 * lines. Amounts are read from the PDF's text; the sign comes from the text, and only when the text
 * has none from the assistant's `direction`. Rejected rows stay in the grid, with the lines' own text
 * and no date or amount, so they show as problems the person can fix or skip.
 */
export function applyRowsPlan(lines: PdfLine[], parts: PlanPart[], period: StatementPeriod, ownIban: string | null = null): RowsOutcome {
  const real = new Map(lines.map((l) => [l.id, l]))
  const own = ownIban?.replace(/\s/g, '').toUpperCase() ?? null
  const used = new Set<number>()
  const accepted: Accepted[] = []
  const refused: { order: number; ids: number[]; reason: string }[] = []

  for (const part of parts) {
    const sent = new Map(part.own.map((m) => [m.id, m]))
    for (const row of part.plan.rows) {
      const ids = row.lines
      const known = ids.filter((id) => sent.has(id))
      const order = Math.min(...(known.length ? known : [Number.MAX_SAFE_INTEGER]))
      const refuse = (reason: string): void => void refused.push({ order, ids: known, reason })
      if (!ids.length) {
        refuse('The assistant named no lines for this row.')
        continue
      }
      if (known.length !== ids.length || new Set(ids).size !== ids.length) {
        refuse('The row uses a line that was not in the text sent, or the same line twice.')
        continue
      }
      if (ids.some((id) => used.has(id))) {
        refuse('A line of this row is already part of another row.')
        continue
      }
      const text = norm(ids.map((id) => sent.get(id)!.plain).join(' '))
      // A date and an amount are required; the other strings may be null (or empty) when the lines don't have them.
      const check = (value: string | null, kind: 'number' | 'date' | 'text', label: string, required = false): string | null =>
        (required || norm(value ?? '')) && !appears(text, value ?? '', kind) && !(kind === 'date' && spansCells(text, value ?? '')) ? `The ${label} “${norm(value ?? '')}” is not in the text of this row’s lines.` : null
      const amount = readAmount(text, row.amount)
      const wrong =
        check(row.date, 'date', 'date', true) ?? check(row.valueDate, 'date', 'value date') ?? ('error' in amount ? amount.error : null) ?? check(row.balance, 'number', 'balance') ?? check(row.counterparty, 'text', 'counterparty')
      if (wrong || 'error' in amount) {
        refuse(wrong ?? ('error' in amount ? amount.error : ''))
        continue
      }
      const realText = norm(ids.map((id) => cellText(real.get(id)!)).join(' '))
      // The account number comes from the real text: the assistant only saw it masked.
      const ibans = findIbans(realText).filter((i) => i !== own)
      let counterparty = norm(row.counterparty ?? '')
      for (const iban of ibans) counterparty = counterparty.split(maskIban(iban)).join(iban)
      let description = realText
      for (const piece of [row.date, row.valueDate, amount.span, row.balance]) {
        if (!piece) continue
        const split = splitDate(piece)
        if (description.includes(norm(piece)) || !split) description = description.replace(norm(piece), ' ')
        else {
          // A date over several cells: its own tokens leave the description.
          const have = tokens(description)
          findTokens(have, split)?.forEach((i) => (have[i] = ''))
          description = have.join(' ')
        }
      }
      ids.forEach((id) => used.add(id))
      accepted.push({
        order,
        ids,
        date: completeYear(norm(row.date), period),
        valueDate: norm(row.valueDate ?? '') ? completeYear(norm(row.valueDate ?? ''), period) : '',
        amount: amount.amount + (row.direction === 'out' && amount.polarity === 'none' ? ' DR' : ''),
        balance: dashes(norm(row.balance ?? '')),
        counterparty,
        description: norm(description),
        iban: ibans[0] ?? ''
      })
    }
  }

  // How this statement writes dates and numbers, from the rows that passed.
  const dateOrder = detectDateOrder(accepted.map((a) => a.date))
  const decimal = detectDecimal(accepted.map((a) => bare(a.amount)))
  const good: Accepted[] = []
  for (const a of accepted) {
    const cents = parseAmount(a.amount, decimal)
    if (!parseDate(a.date, dateOrder)) refused.push({ order: a.order, ids: a.ids, reason: 'The date has no readable day, month and year (the statement may not say which year it is).' })
    else if (cents === null) refused.push({ order: a.order, ids: a.ids, reason: `The amount “${a.amount}” could not be read as a number.` })
    else good.push(a)
  }

  type Line = { order: number; cells: string[]; reason: string | null; ids: number[] }
  const out: Line[] = [
    ...good.map((a) => ({ order: a.order, ids: a.ids, reason: null, cells: [a.date, a.valueDate, a.description, a.counterparty, a.iban, a.amount, a.balance] })),
    ...refused.map((r) => ({ order: r.order, ids: r.ids, reason: r.reason, cells: ['', '', norm(r.ids.map((id) => cellText(real.get(id)!)).join(' ')), '', '', '', ''] }))
  ].sort((a, b) => a.order - b.order)

  const text = norm(parts.flatMap((p) => p.own.map((m) => m.plain)).join(' '))
  const balance = (value: string | null): number | null => (value && appears(text, value, 'number') ? parseAmount(dashes(norm(value)), decimal) : null)
  const first = <T>(values: (T | null)[]): T | null => values.find((v) => v !== null) ?? null
  const plans = parts.map((p) => p.plan)

  return {
    grid: [GRID_HEADER, ...out.map((r) => r.cells)],
    mapping: {
      delimiter: ',',
      headerRow: 0,
      dateOrder,
      decimal,
      invertSign: false,
      columns: { bookingDate: 0, valueDate: 1, description: [2], counterpartyName: 3, counterpartyIban: 4, amount: 5, balance: 6 }
    },
    rejected: out.flatMap((r, row) => (r.reason ? [{ row, lines: r.ids, reason: r.reason }] : [])),
    balances: { opening: first(plans.map((p) => balance(p.openingBalance))), closing: first([...plans].reverse().map((p) => balance(p.closingBalance))) },
    accepted: good.length
  }
}
