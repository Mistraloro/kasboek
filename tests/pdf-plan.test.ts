import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { autoMap } from '@core/csv/mapping'
import { normalizeRows } from '@core/csv/normalize'
import { PdfRowsPlan, applyRowsPlan, maskedLines, parsePdfPlan, partText, splitParts, tableStart, type PdfRowsPlan as Plan } from '@core/pdf-plan'
import type { PdfLine } from '@core/pdf/lines'

// All data here is invented.
const OWN = 'BE68539007547034'
const OTHER = 'BE71096123456769'
const PERIOD = { from: '2026-11-01', to: '2026-11-30' }

/** A line of cells [x, text]; id = position in reading order, one page unless told otherwise. */
const line = (id: number, cells: [number, string][], page = 1): PdfLine => ({
  id,
  page,
  y: 800 - id * 12,
  pageHeight: 842,
  cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 }))
})
const row = (over: Partial<Plan['rows'][number]>): Plan['rows'][number] => ({ lines: [1], date: '03/11', valueDate: null, amount: '45,10-', direction: null, balance: null, counterparty: null, ...over })
const plan = (rows: Plan['rows'], over: Partial<Plan> = {}): Plan => ({ rows, openingBalance: null, closingBalance: null, notes: [], ...over })

const LINES = [
  line(0, [[40, 'Statement of account']]),
  line(1, [[60, '03/11'], [140, 'ALBERT HEIJN BRUSSEL'], [510, '45,10-']]),
  line(2, [[140, `Transfer to Jan Peeters ${OTHER}`]]),
  line(3, [[60, '05/11'], [140, 'SALARY NOVEMBER'], [510, '2.000,00']]),
  line(4, [[60, '07/11'], [140, 'Albert   Heijn   Gent'], [400, '12,00'], [510, '988,00']])
]
const sent = maskedLines(LINES)
const apply = (p: Plan, lines = LINES, own = sent) => applyRowsPlan(lines, [{ own, plan: p }], PERIOD, OWN)
const readBack = (grid: string[][], mapping: ReturnType<typeof apply>['mapping']) => normalizeRows(grid, mapping, 'EUR')

describe('the schema and the answer reader', () => {
  it('has a JSON schema and reads a plain, fenced or slightly wrong answer', () => {
    const schema = z.toJSONSchema(PdfRowsPlan) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['rows', 'openingBalance', 'closingBalance', 'notes'])
    const good = plan([row({})])
    expect(parsePdfPlan(JSON.stringify(good), 'X')).toEqual(good)
    expect(parsePdfPlan('```json\n' + JSON.stringify(good) + '\n```', 'X')).toEqual(good)
    // Line numbers as text are accepted, fields left out count as null, and a row without lines is dropped.
    const loose = { rows: [{ lines: ['1'], date: '03/11', amount: '1,00' }, { date: 'x', amount: '2' }], notes: ['ok'] }
    expect(parsePdfPlan(JSON.stringify(loose), 'X')).toEqual({ rows: [row({ amount: '1,00' })], openingBalance: null, closingBalance: null, notes: ['ok'] })
    expect(() => parsePdfPlan('nope', 'X')).toThrow(/couldn’t be read/)
  })
})

describe('masked lines', () => {
  it('writes id, page and every cell with its position, with numbers masked', () => {
    expect(sent[1]!.text).toBe('L1 p1 | x60 03/11 | x140 ALBERT HEIJN BRUSSEL | x510 45,10-')
    expect(sent[2]!.text).toBe(`L2 p1 | x140 Transfer to Jan Peeters BE…6769`)
    const card = maskedLines([line(0, [[10, 'Card 4929 1234 5678 9012 shop']])])
    expect(card[0]!.text).toBe('L0 p1 | x10 Card …9012 shop')
  })

  it('masks an account number that is split over two cells', () => {
    const [m] = maskedLines([line(0, [[10, 'BE71 0961'], [200, '2345 6769']])])
    expect(m!.text).not.toMatch(/2345|0961/)
    expect(m!.text).toContain('BE…6769')
  })

  it('leaves out everything above the table, when its header is known', () => {
    const lines = [line(0, [[40, 'Jan Jansen']]), line(1, [[40, 'Main Street 1, Springfield']]), line(2, [[60, 'Date'], [140, 'Description'], [510, 'Amount']]), line(3, [[60, '03/11'], [140, 'Shop'], [510, '1,00-']])]
    const start = tableStart(lines)
    expect(start).toBe(2)
    expect(maskedLines(lines, { skipBefore: start }).map((m) => m.id)).toEqual([2, 3])
    // No header known: everything goes, masked.
    expect(tableStart([lines[0]!, lines[1]!])).toBeNull()
    expect(maskedLines(lines).map((m) => m.id)).toEqual([0, 1, 2, 3])
  })

  it('splits into parts of 4 pages and repeats the last 3 lines as context', () => {
    const many = Array.from({ length: 9 }, (_, p) => [line(p * 2, [[60, `0${p + 1}/11`], [510, '1,00']], p + 1), line(p * 2 + 1, [[60, 'x']], p + 1)]).flat()
    const parts = splitParts(maskedLines(many))
    expect(parts.map((p) => [...new Set(p.own.map((m) => m.page))])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]])
    expect(parts[0]!.context).toEqual([])
    expect(parts[1]!.context.map((m) => m.id)).toEqual([5, 6, 7])
    expect(partText(parts[1]!)).toContain('(context only) L5 p3')
    // The character limit splits too.
    const wide = Array.from({ length: 5 }, (_, i) => line(i, [[10, 'x'.repeat(900)]]))
    expect(splitParts(maskedLines(wide, {})).length).toBe(1)
    const wider = Array.from({ length: 80 }, (_, i) => line(i, [[10, 'y'.repeat(900)]]))
    expect(splitParts(maskedLines(wider)).length).toBeGreaterThan(1)
  })
})

describe('dates over several cells or lines (block layouts)', () => {
  const BLOCK = [
    line(0, [[40, 'Relevé du 1 mars au 31 mars 2026']]),
    line(1, [[40, '3'], [140, 'EPICERIE DU COIN'], [510, '12,50-']]),
    line(2, [[40, 'mars']]),
    line(3, [[40, '5'], [140, 'VIREMENT SALAIRE'], [510, '1.500,00']]),
    line(4, [[140, 'Paiement carte']]),
    line(5, [[40, 'avril']]),
    line(6, [[40, 'Page 1/5']])
  ]
  const blockSent = maskedLines(BLOCK)
  const run = (rows: Plan['rows'], period: { from: string | null; to: string | null } = { from: '2026-03-01', to: '2026-03-31' }) => applyRowsPlan(BLOCK, [{ own: blockSent, plan: plan(rows) }], period, OWN)

  it('accepts a day above its month and reads it with the statement period', () => {
    const r = run([row({ lines: [1, 2], date: '3 mars', amount: '12,50-' })])
    expect(r.accepted).toBe(1)
    expect(r.grid[1]!.slice(0, 3)).toEqual(['3 mars 2026', '', 'EPICERIE DU COIN'])
    expect(readBack(r.grid, r.mapping)[0]!.bookingDate).toBe('2026-03-03')
  })

  it('accepts a day on the first line and its month on the third, in order of reading', () => {
    const r = run([row({ lines: [3, 4, 5], date: '5 avril', amount: '1.500,00' })], { from: '2026-03-01', to: '2026-04-30' })
    expect(r.accepted).toBe(1)
    expect(r.grid[1]![2]).toBe('VIREMENT SALAIRE Paiement carte')
    expect(r.grid[1]![0]).toBe('5 avril 2026')
  })

  it('still accepts the fully adjacent form, with a trailing dot or a year', () => {
    const lines = [line(0, [[40, '3 mars.'], [140, 'SHOP'], [510, '1,00-']]), line(1, [[40, '4'], [60, 'MÄRZ'], [140, 'SHOP'], [510, '2,00-']])]
    const r = applyRowsPlan(lines, [{ own: maskedLines(lines), plan: plan([row({ lines: [0], date: '3 mars.', amount: '1,00-' }), row({ lines: [1], date: '4 MÄRZ 2026', amount: '2,00-' })]) }], PERIOD, OWN)
    expect(r.rejected.map((x) => x.reason)).toEqual(['The date “4 MÄRZ 2026” is not in the text of this row’s lines.'])
  })

  it('refuses a month the lines do not have, tokens in the wrong order and tokens from other rows', () => {
    expect(run([row({ lines: [1, 2], date: '3 avril', amount: '12,50-' })]).accepted).toBe(0)
    expect(run([row({ lines: [1, 2], date: 'mars 3', amount: '12,50-' })]).accepted).toBe(0)
    // Line 5 says "avril", but it is not one of this row's lines.
    expect(run([row({ lines: [1], date: '3 avril', amount: '12,50-' })]).accepted).toBe(0)
  })

  it('refuses "3 mars" when the lines say "3" and "avril"', () => {
    const r = run([row({ lines: [3, 5], date: '3 mars', amount: '1.500,00' })])
    expect(r.accepted).toBe(0)
    expect(r.rejected[0]!.reason).toMatch(/not in the text/)
  })

  it('does not take a day that is only part of a longer number or a page footer for a date', () => {
    expect(run([row({ lines: [1, 2], date: '13 mars', amount: '12,50-' })]).accepted).toBe(0)
    // "1/5" is one token and has no month: not a date made of "1" and "5".
    expect(run([row({ lines: [5, 6], date: '1 5', amount: '1,00' })]).accepted).toBe(0)
    expect(run([row({ lines: [2, 6], date: 'mars 1', amount: '1,00' })]).accepted).toBe(0)
  })

  it('refuses a date without a year when no period can complete it', () => {
    const r = run([row({ lines: [1, 2], date: '3 mars', amount: '12,50-' })], { from: null, to: null })
    expect(r.accepted).toBe(0)
    expect(r.rejected[0]!.reason).toMatch(/year/)
  })

  it('reads month names in every language, short and long, with and without a dot', () => {
    const names = [['3', 'mars', '2026-03-03'], ['3', 'mrt.', '2026-03-03'], ['3', 'März', '2026-03-03'], ['3', 'March', '2026-03-03'], ['3', 'marzo', '2026-03-03'], ['3', 'março', '2026-03-03'], ['9', 'dez.', '2026-12-09'], ['9', 'sept', '2026-09-09'], ['9', 'okt', '2026-10-09'], ['9', 'janv.', '2026-01-09']]
    for (const [day, month, iso] of names) {
      const lines = [line(0, [[40, day!], [140, 'SHOP'], [510, '1,00-']]), line(1, [[40, month!]]), line(2, [[40, '8'], [140, 'SHOP'], [510, '2,00-']]), line(3, [[40, month!]])]
      const r = applyRowsPlan(lines, [{ own: maskedLines(lines), plan: plan([row({ lines: [0, 1], date: `${day} ${month}`, amount: '1,00-' }), row({ lines: [2, 3], date: `8 ${month}`, amount: '2,00-' })]) }], { from: '2026-01-01', to: '2026-12-31' }, OWN)
      expect(r.accepted, `${day} ${month}`).toBe(2)
      expect(readBack(r.grid, r.mapping)[0]!.bookingDate, `${day} ${month}`).toBe(iso)
    }
  })
})

describe('applyRowsPlan', () => {
  it('reads an accepted row from the text: date, amount with its own sign, counterparty, balance', () => {
    const r = apply(plan([row({ lines: [1], counterparty: 'ALBERT HEIJN BRUSSEL', balance: null })], { closingBalance: '988,00' }))
    expect(r.rejected).toEqual([])
    expect(r.grid[0]).toEqual(['Date', 'Value date', 'Description', 'Counterparty', 'IBAN', 'Amount', 'Balance'])
    // The year comes from the statement period; the description keeps the rest of the text.
    expect(r.grid[1]).toEqual(['03/11/2026', '', 'ALBERT HEIJN BRUSSEL', 'ALBERT HEIJN BRUSSEL', '', '45,10-', ''])
    expect(r.mapping).toMatchObject({ dateOrder: 'DMY', decimal: ',', headerRow: 0 })
    expect(readBack(r.grid, r.mapping)[0]).toMatchObject({ bookingDate: '2026-11-03', amountCents: -4510 })
    expect(r.balances).toEqual({ opening: null, closing: 98800 })
    // The grid can also be mapped by the usual detection.
    expect(autoMap(r.grid, ',')).not.toBeNull()
  })

  it('rejects a row whose amount, date, balance or counterparty is not in its own lines', () => {
    const r = apply(
      plan([
        row({ lines: [1], amount: '54,10-' }),
        row({ lines: [3], date: '06/11', amount: '2.000,00' }),
        row({ lines: [3], date: '05/11', amount: '2.000,00', balance: '1,00' }),
        row({ lines: [3], date: '05/11', amount: '2.000,00', counterparty: 'Someone else' }),
        // The amount is in the text, but in the line of another row.
        row({ lines: [3], date: '05/11', amount: '45,10-' })
      ])
    )
    expect(r.accepted).toBe(0)
    expect(r.rejected.map((x) => x.reason.match(/The (\w+(?: \w+)?) “/)?.[1] ?? x.reason)).toEqual(['amount', 'date', 'balance', 'counterparty', 'amount'])
    // They stay in the grid as problem rows with the lines' own text and no date or amount.
    const rows = readBack(r.grid, r.mapping)
    expect(rows[0]).toMatchObject({ bookingDate: null, amountCents: null })
    expect(rows.every((x) => x.issues.includes('date_invalid') && x.issues.includes('amount_invalid'))).toBe(true)
    expect(r.grid[1]![2]).toContain('ALBERT HEIJN')
  })

  it('does not take a number that is only part of a longer one', () => {
    expect(apply(plan([row({ lines: [3], date: '05/11', amount: '000,00' })])).accepted).toBe(0)
    expect(apply(plan([row({ lines: [1], date: '3/11' })])).accepted).toBe(0)
  })

  it('uses every line once and only lines that were sent in that part', () => {
    const twice = apply(plan([row({ lines: [1, 2] }), row({ lines: [2], amount: '45,10-' })]))
    expect(twice.accepted).toBe(1)
    expect(twice.rejected[0]!.reason).toMatch(/already part of another row/)
    const outside = apply(plan([row({ lines: [1, 99] }), row({ lines: [] })]))
    expect(outside.accepted).toBe(0)
    expect(outside.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/not in the text sent/), expect.stringMatching(/no lines/)])
    // A line of another part (or context) is not allowed either.
    const [first, second] = [sent.slice(0, 2), sent.slice(2)]
    const parts = applyRowsPlan(LINES, [{ own: first, plan: plan([row({ lines: [1] })]) }, { own: second, plan: plan([row({ lines: [1] })]) }], PERIOD, OWN)
    expect(parts.accepted).toBe(1)
    expect(parts.rejected).toHaveLength(1)
  })

  it('takes the sign from the text, and from direction only when the text has none', () => {
    const r = apply(
      plan([
        // Text says minus; the assistant's direction is ignored.
        row({ lines: [1], direction: 'in' }),
        // No sign in the text: direction decides.
        row({ lines: [4], date: '07/11', amount: '12,00', direction: 'out' }),
        // No sign and no direction: as written.
        row({ lines: [3], date: '05/11', amount: '2.000,00' })
      ])
    )
    const rows = readBack(r.grid, r.mapping)
    expect(rows.map((x) => x.amountCents)).toEqual([-4510, 200000, -1200])
    expect(r.rejected).toEqual([])
    const inRow = apply(plan([row({ lines: [3], date: '05/11', amount: '2.000,00', direction: 'in' })]))
    expect(readBack(inRow.grid, inRow.mapping)[0]!.amountCents).toBe(200000)
  })

  it('shows the counterparty account unmasked, recovered from the original lines', () => {
    const r = apply(plan([row({ lines: [1, 2], counterparty: 'Jan Peeters BE…6769' })]))
    expect(r.grid[1]![3]).toBe(`Jan Peeters ${OTHER}`)
    expect(r.grid[1]![4]).toBe(OTHER)
    expect(readBack(r.grid, r.mapping)[0]).toMatchObject({ counterpartyIban: OTHER })
    // The account's own number is never taken for the counterparty's.
    const own = [line(0, [[60, '03/11'], [140, `From ${OWN} shop`], [510, '5,00-']])]
    const o = applyRowsPlan(own, [{ own: maskedLines(own), plan: plan([row({ lines: [0], amount: '5,00-' })]) }], PERIOD, OWN)
    expect(o.grid[1]![4]).toBe('')
  })

  it('compares whitespace-normalised text', () => {
    const r = apply(plan([row({ lines: [4], date: '07/11', amount: '12,00', direction: 'out', counterparty: 'Albert Heijn Gent', balance: '988,00' })]))
    expect(r.accepted).toBe(1)
    expect(r.grid[1]).toEqual(['07/11/2026', '', 'Albert Heijn Gent', 'Albert Heijn Gent', '', '12,00 DR', '988,00'])
  })

  it('keeps document order over parts and rejected rows, and a year-less date without a period is refused', () => {
    const parts = applyRowsPlan(
      LINES,
      [
        { own: sent.slice(3), plan: plan([row({ lines: [3], date: '05/11', amount: '2.000,00' })]) },
        { own: sent.slice(0, 3), plan: plan([row({ lines: [1] }), row({ lines: [2], amount: '1,00' })]) }
      ],
      PERIOD,
      OWN
    )
    expect(parts.grid.slice(1).map((r) => r[0])).toEqual(['03/11/2026', '', '05/11/2026'])
    expect(parts.rejected.map((r) => r.row)).toEqual([1])
    const noYear = applyRowsPlan(LINES, [{ own: sent, plan: plan([row({})]) }], { from: null, to: null }, OWN)
    expect(noYear.accepted).toBe(0)
    expect(noYear.rejected[0]!.reason).toMatch(/year/)
  })

  it('reads American dates and numbers as the statement writes them', () => {
    const us = [line(0, [[60, '11/18/2026'], [140, 'COFFEE'], [510, '1,234.50-']]), line(1, [[60, '11/20/2026'], [140, 'PAY'], [510, '2,000.00']])]
    const r = applyRowsPlan(us, [{ own: maskedLines(us), plan: plan([row({ lines: [0], date: '11/18/2026', amount: '1,234.50-' }), row({ lines: [1], date: '11/20/2026', amount: '2,000.00' })]) }], PERIOD, OWN)
    expect(r.mapping).toMatchObject({ dateOrder: 'MDY', decimal: '.' })
    expect(readBack(r.grid, r.mapping).map((x) => [x.bookingDate, x.amountCents])).toEqual([['2026-11-18', -123450], ['2026-11-20', 200000]])
  })

  it('takes balances only when they are literally in the text', () => {
    const r = apply(plan([row({})], { openingBalance: '1.000,00', closingBalance: '988,00' }))
    // 1.000,00 is not in the text that was sent (only 2.000,00 is).
    expect(r.balances).toEqual({ opening: null, closing: 98800 })
  })
})
