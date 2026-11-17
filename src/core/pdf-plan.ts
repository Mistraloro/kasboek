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
import { AppError } from './errors'
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
  let raw: unknown
  try {
    raw = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    )
  } catch {
    throw new AppError('assistant.bad_plan', `${name}’s answer couldn’t be read. Try again, or try another model.`)
  }
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

/**
 * The lines as they are sent: IBANs and runs of 13 or more digits masked, and, with `skipBefore`
 * (the table's first line), everything above the table left out: the name and address blocks and the
 * header of the first page.
 */
export function maskedLines(lines: PdfLine[], opts: { skipBefore?: number | null } = {}): MaskedLine[] {
  const skip = opts.skipBefore ?? null
  return lines
    .filter((l) => skip === null || l.id >= skip)
    .map((l) => {
      const cells = l.cells.map((c) => ({ x: Math.round(c.x0), text: maskNumbers(c.text).slice(0, MAX_LINE_CHARS) }))
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

/** At most this many pages and characters go to the assistant in one call. */
export const MAX_PART_PAGES = 4
export const MAX_PART_CHARS = 40_000
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
    if (current.length && (chars + size > MAX_PART_CHARS || (!pages.has(m.page) && pages.size >= MAX_PART_PAGES))) {
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

/** A sign the text itself has: minus, plus, brackets, or DR / CR. */
const HAS_SIGN = /[-+(]|\b(?:CR|DR)\b/i

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
      const wrong =
        check(row.date, 'date', 'date', true) ?? check(row.valueDate, 'date', 'value date') ?? check(row.amount, 'number', 'amount', true) ?? check(row.balance, 'number', 'balance') ?? check(row.counterparty, 'text', 'counterparty')
      if (wrong) {
        refuse(wrong)
        continue
      }
      const realText = norm(ids.map((id) => cellText(real.get(id)!)).join(' '))
      // The account number comes from the real text: the assistant only saw it masked.
      const ibans = findIbans(realText).filter((i) => i !== own)
      let counterparty = norm(row.counterparty ?? '')
      for (const iban of ibans) counterparty = counterparty.split(maskIban(iban)).join(iban)
      let description = realText
      for (const piece of [row.date, row.valueDate, row.amount, row.balance]) {
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
        amount: dashes(norm(row.amount)) + (row.direction === 'out' && !HAS_SIGN.test(dashes(row.amount)) ? ' DR' : ''),
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
