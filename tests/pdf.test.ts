import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { analyze, analyzeGrid, commit, commitSummary, pdfLines, replaceGrid, sessionKind, updateRows, type PdfSessionData } from '@core/import'
import { autoMap } from '@core/csv/mapping'
import { normalizeRows } from '@core/csv/normalize'
import { toLines, type PdfLine, type PdfText, type PdfTextItem } from '@core/pdf/lines'
import { completeYear, readStatement, reconcile } from '@core/pdf/statement'

const OWN = 'BE68539007547034'
const OTHER = 'BE71096123456769'

/** One page of text: rows of [x, text] at descending y (as pdf.js reports them), 10 pt text, 5 pt per character. */
function page(n: number, rows: [number, string][][], top = 800, step = 12): PdfText['pages'][number] {
  const items: PdfTextItem[] = rows.flatMap((row, r) => row.map(([x, str]) => ({ str, x, y: top - r * step, w: str.length * 5, h: 10 })))
  return { n, width: 595, height: 842, items }
}
const text = (...pages: PdfText['pages']): PdfText => ({ pages, pageCount: pages.length })
const linesOf = (...pages: PdfText['pages']): PdfLine[] => toLines(text(...pages))

const XS = [40, 110, 300, 380, 460]
/** A header and rows laid out in columns; empty strings leave the column empty. */
const table = (header: string[], rows: string[][], xs = XS): [number, string][][] => [header, ...rows].map((r) => r.flatMap((c, i) => (c ? [[xs[i]!, c] as [number, string]] : [])))
const clean = (grid: string[][]) => normalizeRows(grid, autoMap(grid, ',')!, 'EUR')

describe('toLines', () => {
  it('clusters items into lines by baseline and cells by gap, in reading order', () => {
    const p1: PdfText['pages'][number] = {
      n: 1,
      width: 595,
      height: 842,
      items: [
        { str: 'Heijn', x: 132, y: 699.8, w: 28, h: 10 },
        { str: '03/11/2026', x: 40, y: 700.2, w: 50, h: 10 },
        { str: 'Albert', x: 100, y: 700, w: 30, h: 10 },
        { str: '12', x: 400, y: 700, w: 10, h: 10 },
        { str: ',50', x: 410, y: 700, w: 15, h: 10 },
        { str: 'Totaal', x: 40, y: 600, w: 30, h: 10 },
        { str: ' ', x: 300, y: 600, w: 3, h: 10 },
        { str: 'Kop', x: 40, y: 750, w: 15, h: 10 }
      ]
    }
    const p2: PdfText['pages'][number] = { n: 2, width: 595, height: 842, items: [{ str: 'Pagina 2', x: 40, y: 800, w: 40, h: 10 }] }
    const lines = toLines({ pages: [p2, p1], pageCount: 2 })
    expect(lines.map((l) => [l.id, l.page, l.cells.map((c) => c.text)])).toEqual([
      [0, 1, ['Kop']],
      [1, 1, ['03/11/2026', 'Albert Heijn', '12,50']],
      [2, 1, ['Totaal']],
      [3, 2, ['Pagina 2']]
    ])
    expect(lines[1]!.cells[1]).toMatchObject({ x0: 100, x1: 160 })
  })
})

/** The same statement in six languages: a payment out and a payment in. */
const LANGUAGES: { name: string; header: string[]; rows: string[][]; dates: string[]; cents: number[] }[] = [
  { name: 'nl', header: ['Datum', 'Omschrijving', 'Bedrag', 'Saldo'], rows: [['03-11-2026', 'Albert Heijn', '-23,45', '976,55'], ['05-11-2026', 'Werkgever BV', '2.500,00', '3.476,55']], dates: ['2026-11-03', '2026-11-05'], cents: [-2345, 250000] },
  { name: 'fr', header: ['Date', 'Libellé de l’opération', 'Débit', 'Crédit'], rows: [['03/11/2026', 'CARTE JUMBO', '23,45', ''], ['05/11/2026', 'VIREMENT SALAIRE', '', '2 500,00']], dates: ['2026-11-03', '2026-11-05'], cents: [-2345, 250000] },
  { name: 'de', header: ['Buchungstag', 'Vorgang', 'Soll', 'Haben'], rows: [['03.11.2026', 'Kartenzahlung REWE', '27,80', ''], ['05.11.2026', 'Gehalt', '', '3.100,00']], dates: ['2026-11-03', '2026-11-05'], cents: [-2780, 310000] },
  { name: 'en', header: ['Date', 'Transaction details', 'Paid out', 'Paid in', 'Balance'], rows: [['03 Nov 2026', 'Tesco Stores', '8.49', '', '991.51'], ['05 Nov 2026', 'Salary', '', '1,234.56', '2,226.07']], dates: ['2026-11-03', '2026-11-05'], cents: [-849, 123456] },
  { name: 'es', header: ['Fecha', 'Concepto', 'Importe', 'Saldo'], rows: [['03/11/2026', 'Pago con tarjeta', '-45,10', '954,90'], ['05/11/2026', 'Nómina', '1.200,00', '2.154,90']], dates: ['2026-11-03', '2026-11-05'], cents: [-4510, 120000] },
  { name: 'pt', header: ['Data mov', 'Descrição', 'Débito', 'Crédito'], rows: [['03-11-2026', 'Compra Continente', '30,00', ''], ['05-11-2026', 'Transferência recebida', '', '50,00']], dates: ['2026-11-03', '2026-11-05'], cents: [-3000, 5000] }
]

describe('readStatement: tables', () => {
  for (const l of LANGUAGES) {
    it(`reads a ${l.name} statement into the grid a CSV would give`, () => {
      const read = readStatement(linesOf(page(1, [[[40, 'Statement']], ...table(l.header, l.rows)])))
      expect(read.headerFound).toBe(true)
      expect(read.grid[0]).toEqual(l.header)
      expect(read.grid.slice(1)).toEqual(l.rows)
      const rows = clean(read.grid)
      expect(rows.map((r) => r.bookingDate)).toEqual(l.dates)
      expect(rows.map((r) => r.amountCents)).toEqual(l.cents)
      expect(rows.every((r) => r.issues.length === 0)).toBe(true)
    })
  }

  it('reads a D/C direction column', () => {
    const read = readStatement(linesOf(page(1, table(['Date', 'Description', 'Amount', 'D/C'], [['2026-11-03', 'Shop', '12.50', 'D'], ['2026-11-04', 'Salary', '100.00', 'C']]))))
    expect(clean(read.grid).map((r) => r.amountCents)).toEqual([-1250, 10000])
  })

  it('reads DR/CR suffixes, brackets and a trailing minus', () => {
    const dr = readStatement(linesOf(page(1, table(['Date', 'Description', 'Amount'], [['03/11/2026', 'Shop', '12.50 DR'], ['04/11/2026', 'Refund', '100.00 CR']]))))
    expect(clean(dr.grid).map((r) => r.amountCents)).toEqual([-1250, 10000])
    const other = readStatement(linesOf(page(1, table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Shop', '(4,00)'], ['04/11/2026', 'Winkel', '12,50-'], ['05/11/2026', 'Loon', '3,00']]))))
    expect(clean(other.grid).map((r) => r.amountCents)).toEqual([-400, -1250, 300])
  })

  it('appends lines without a date to the description of the row above', () => {
    const rows = table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Betaling Delhaize', '-45,10'], ['', 'Brugge BE', ''], ['', 'Kaart 1234', ''], ['05/11/2026', 'Overschrijving', '12,00']])
    const read = readStatement(linesOf(page(1, rows)))
    expect(read.grid.slice(1)).toEqual([['03/11/2026', 'Betaling Delhaize Brugge BE Kaart 1234', '-45,10'], ['05/11/2026', 'Overschrijving', '12,00']])
    expect(read.droppedLines).toBe(0)
  })

  it('takes the columns again from a header repeated on the next page, and skips carry-forward lines', () => {
    const p1 = page(1, [...table(['Datum', 'Omschrijving', 'Bedrag', 'Saldo'], [['03/11/2026', 'Eerste', '-10,00', '90,00']]), [[110, 'Transport'], [380, '90,00']]])
    const wide = [40, 150, 420, 500]
    const p2 = page(2, [[[110, 'Transport'], [500, '90,00']], ...table(['Datum', 'Omschrijving', 'Bedrag', 'Saldo'], [['04/11/2026', 'Tweede', '-5,00', '85,00']], wide)])
    const read = readStatement(linesOf(p1, p2))
    expect(read.grid.slice(1)).toEqual([['03/11/2026', 'Eerste', '-10,00', '90,00'], ['04/11/2026', 'Tweede', '-5,00', '85,00']])
    expect(read.droppedLines).toBe(0)
  })

  it('keeps a footer out of the last row', () => {
    const rows = table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Laatste', '-1,00']])
    const glued = readStatement(linesOf(page(1, [...rows, [[40, 'Pagina 1 van 1']]])))
    expect(glued.grid[1]).toEqual(['03/11/2026', 'Laatste', '-1,00'])
    expect(glued.droppedLines).toBe(1)
    // In the description column, but far below the table.
    const apart = readStatement(linesOf(page(1, [...rows, [], [], [], [[110, 'Vragen? Bel 0800 12 345']]])))
    expect(apart.grid[1]).toEqual(['03/11/2026', 'Laatste', '-1,00'])
    expect(apart.droppedLines).toBe(1)
  })

  it('reports no table when there is no header', () => {
    const read = readStatement(linesOf(page(1, [[[40, 'Welkom bij uw bank']], [[40, 'Geen tabel hier']]])))
    expect(read).toMatchObject({ grid: [], headerFound: false })
  })

  it('adds an IBAN column for an IBAN other than the account’s own', () => {
    const rows = table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', `Overschrijving naar ${OTHER.replace(/(.{4})/g, '$1 ').trim()}`, '-10,00'], ['04/11/2026', `Van ${OWN}`, '5,00'], ['05/11/2026', 'Winkel', '-2,00']])
    const read = readStatement(linesOf(page(1, rows)), OWN)
    expect(read.grid.map((r) => r.at(-1))).toEqual(['IBAN', OTHER, '', ''])
    expect(clean(read.grid)[0]!.counterpartyIban).toBe(OTHER)
    const none = readStatement(linesOf(page(1, table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Winkel', '-2,00']]))), OWN)
    expect(none.grid[0]).toEqual(['Datum', 'Omschrijving', 'Bedrag'])
  })

  it('notes a statement that seems to be for another account', () => {
    const head = (iban: string): [number, string][][] => [[[40, `IBAN ${iban}`]], ...table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Winkel', '-2,00']])]
    expect(readStatement(linesOf(page(1, head(OTHER))), OWN).notes).toEqual([{ code: 'other_account', iban: 'BE…6769' }])
    expect(readStatement(linesOf(page(1, head(OWN))), OWN).notes).toEqual([])
    expect(readStatement(linesOf(page(1, table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11/2026', 'Winkel', '-2,00']]))), OWN).notes).toEqual([])
    expect(readStatement(linesOf(page(1, head(OTHER)))).notes).toEqual([])
  })
})

describe('readStatement: balances and period', () => {
  const OPENING = ['Opening balance', 'Beginsaldo', 'Oud saldo', 'Solde précédent', 'Ancien solde', 'Alter Kontostand', 'Anfangssaldo', 'Saldo anterior', 'Saldo inicial']
  const CLOSING = ['Closing balance', 'Eindsaldo', 'Nieuw saldo', 'Solde final', 'Nouveau solde', 'Neuer Kontostand', 'Endsaldo', 'Saldo final', 'Saldo actual']
  const read = (...cells: [number, string][]) => readStatement(linesOf(page(1, [cells])))

  for (const label of OPENING)
    it(`reads the opening balance after "${label}"`, () => {
      expect(read([40, label], [400, '1.000,00']).balances).toEqual({ opening: 100000, closing: null })
      expect(read([40, `${label} 01/10/2026`], [400, '1 000,00']).balances.opening).toBe(100000)
    })
  for (const label of CLOSING)
    it(`reads the closing balance after "${label}"`, () => {
      expect(read([40, label], [400, '1,000.00']).balances).toEqual({ opening: null, closing: 100000 })
      expect(read([40, `${label} 1,000.00`]).balances.closing).toBe(100000)
    })

  it('reads balances with a sign and both on one line', () => {
    expect(read([40, 'Closing balance'], [400, '250.00 DR']).balances.closing).toBe(-25000)
    expect(read([40, 'Opening balance'], [200, '100.00'], [300, 'Closing balance'], [500, '150.00']).balances).toEqual({ opening: 10000, closing: 15000 })
  })

  it('skips carry-forward lines', () => {
    for (const label of ['Balance brought forward', 'Balance carried forward', 'Transport', 'À reporter', 'Übertrag', 'Suma y sigue'])
      expect(read([40, label], [400, '1,234.56']).balances, label).toEqual({ opening: null, closing: null })
    // A payment that happens to be called "Übertrag auf Sparkonto" or "Transport" is a row.
    const rows = table(['Datum', 'Verwendungszweck', 'Betrag'], [['03.11.2026', 'Übertrag auf Sparkonto', '-50,00'], ['04.11.2026', 'Transport', '-2,00']])
    expect(readStatement(linesOf(page(1, rows))).grid.length).toBe(3)
  })

  it('reads the period in each language', () => {
    const period = (line: string) => readStatement(linesOf(page(1, [[[40, line]]]))).period
    const expected = { from: '2026-10-01', to: '2026-10-31' }
    expect(period('Statement period: from 01/10/2026 to 31/10/2026')).toEqual(expected)
    expect(period('Periode: van 01-10-2026 tot 31-10-2026')).toEqual(expected)
    expect(period('Relevé du 01/10/2026 au 31/10/2026')).toEqual(expected)
    expect(period('Kontoauszug vom 01.10.2026 bis 31.10.2026')).toEqual(expected)
    expect(period('Extracto del 01/10/2026 al 31/10/2026')).toEqual(expected)
    expect(period('Extrato de 01/10/2026 até 31/10/2026')).toEqual(expected)
    expect(period('From 1 Oct 2026 to 31 Oct 2026')).toEqual(expected)
    expect(period('Periode 01.10.2026 - 31.10.2026')).toEqual(expected)
    expect(period('Niets te zien')).toEqual({ from: null, to: null })
  })

  it('completes dates without a year from the period, across the new year', () => {
    const december = { from: '2026-12-15', to: '2027-01-14' }
    expect(completeYear('20/12', december)).toBe('20/12/2026')
    expect(completeYear('02/01', december)).toBe('02/01/2027')
    expect(completeYear('03 NOV', { from: '2026-10-15', to: '2026-11-14' })).toBe('03 NOV 2026')
    expect(completeYear('03.11.', { from: '2026-10-15', to: '2026-11-14' })).toBe('03.11.2026')
    expect(completeYear('03/11/2026', december)).toBe('03/11/2026')
    expect(completeYear('03/11', { from: null, to: null })).toBe('03/11')
    expect(completeYear('Winkel', december)).toBe('Winkel')

    const rows = table(['Datum', 'Omschrijving', 'Bedrag'], [['20/12', 'Winkel', '-10,00'], ['02/01', 'Loon', '100,00']])
    const read = readStatement(linesOf(page(1, [[[40, 'Periode: van 15/12/2026 tot 14/01/2027']], ...rows])))
    expect(clean(read.grid).map((r) => r.bookingDate)).toEqual(['2026-12-20', '2027-01-02'])
    const named = readStatement(linesOf(page(1, [[[40, 'Periode: van 15/10/2026 tot 14/11/2026']], ...table(['Datum', 'Omschrijving', 'Bedrag'], [['03 NOV', 'Winkel', '-10,00']])])))
    expect(clean(named.grid)[0]!.bookingDate).toBe('2026-11-03')
  })

  it('uses a printed year when there is no period, and says so when there is none', () => {
    const rows = table(['Datum', 'Omschrijving', 'Bedrag'], [['03/11', 'Winkel', '-10,00']])
    expect(clean(readStatement(linesOf(page(1, [[[40, 'Afschrift 2026']], ...rows]))).grid)[0]!.bookingDate).toBe('2026-11-03')
    const none = readStatement(linesOf(page(1, rows)))
    expect(none.grid).toEqual([])
    expect(none.notes).toEqual([{ code: 'dates_without_year' }])
  })

  it('reads the balances of a whole statement', () => {
    const rows: [number, string][][] = [
      [[40, 'Periode: van 01/10/2026 tot 31/10/2026']],
      [[110, 'Oud saldo'], [460, '1.000,00']],
      ...table(['Datum', 'Omschrijving', 'Bedrag', 'Saldo'], [['03/10/2026', 'Albert Heijn', '-23,45', '976,55']], [40, 110, 300, 460]),
      [[110, 'Nieuw saldo'], [460, '976,55']]
    ]
    const read = readStatement(linesOf(page(1, rows)))
    expect(read).toMatchObject({ balances: { opening: 100000, closing: 97655 }, period: { from: '2026-10-01', to: '2026-10-31' }, droppedLines: 0 })
    expect(read.grid.length).toBe(2)
  })
})

describe('reconcile', () => {
  const rows = [
    { amountCents: -2345, balanceCents: 97655 },
    { amountCents: 250000, balanceCents: 347655 }
  ]
  it('adds up when opening plus rows is closing', () => {
    expect(reconcile(rows, { opening: 100000, closing: 347655 })).toEqual({ openingCents: 100000, closingCents: 347655, sumCents: 247655, differenceCents: 0, rowsChecked: 2, runningMismatches: 0 })
  })
  it('shows the difference and a running balance that does not follow', () => {
    expect(reconcile(rows, { opening: 100000, closing: 340000 }).differenceCents).toBe(-7655)
    expect(reconcile([rows[0]!, { amountCents: 250000, balanceCents: 300000 }], { opening: 100000, closing: 300000 }).runningMismatches).toBe(1)
  })
  it('has no difference without both balances, and reads a newest-first file', () => {
    expect(reconcile(rows, { opening: null, closing: 347655 }).differenceCents).toBeNull()
    expect(reconcile([...rows].reverse(), { opening: 100000, closing: 347655 })).toMatchObject({ differenceCents: 0, runningMismatches: 0 })
    expect(reconcile(rows.map((r) => ({ ...r, balanceCents: null })), { opening: 100000, closing: 347655 })).toMatchObject({ differenceCents: 0, runningMismatches: 0 })
  })
})

// ------------------------------------------------------------------------------- the session

function db() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-pdf-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(d.prepare("INSERT INTO accounts (name, bank) VALUES ('Main', 'bank')").run().lastInsertRowid)
  return { d, acc }
}
const LINE: PdfLine = { id: 0, page: 1, y: 700, cells: [{ text: 'Rekeningafschrift', x0: 40, x1: 120 }] }
const pdf = (over: Partial<PdfSessionData> = {}): PdfSessionData => ({ lines: [LINE], pages: 1, readBy: 'kasboek', balances: { opening: 100000, closing: 347655 }, period: { from: '2026-10-01', to: '2026-10-31' }, ...over })
const GRID = [
  ['Datum', 'Omschrijving', 'Bedrag', 'Saldo'],
  ['03-10-2026', 'Albert Heijn', '-23,45', '976,55'],
  ['05-10-2026', 'Werkgever BV', '2.500,00', '3.476,55']
]
const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}

describe('PDF sessions', () => {
  it('opens a session from a grid and reconciles it with the printed balances', () => {
    const { d, acc } = db()
    const p = analyzeGrid(d, { fileName: 'afschrift.pdf', accountId: acc, grid: GRID, pdf: pdf() })
    expect(p).toMatchObject({ fileKind: 'pdf', mappingSource: 'detected', stats: { total: 2, ready: 2 } })
    expect(p.pdf).toEqual({ pages: 1, readBy: 'kasboek', tableFound: true, reconciliation: { openingCents: 100000, closingCents: 347655, sumCents: 247655, differenceCents: 0, rowsChecked: 2, runningMismatches: 0 } })
    expect(sessionKind(p.sessionId)).toBe('pdf')
    expect(pdfLines(p.sessionId)).toEqual([LINE])
  })

  it('keeps a session without a table, for a later read', () => {
    const { d, acc } = db()
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: [], pdf: pdf() })
    expect(p).toMatchObject({ mapping: null, rows: [], pdf: { tableFound: false, reconciliation: null } })
    expect(errorCode(() => analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: [], pdf: pdf({ lines: [] }) }))).toBe('import.empty')
    const again = replaceGrid(d, p.sessionId, GRID, null, { readBy: 'assistant' })
    expect(again).toMatchObject({ stats: { ready: 2 }, pdf: { tableFound: true, readBy: 'assistant' } })
  })

  it('resets the changes and the check when the grid is replaced', () => {
    const { d, acc } = db()
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: GRID, pdf: pdf() })
    expect(updateRows(d, p.sessionId, [{ index: 0, decided: 'skip' }]).stats.skipped).toBe(1)
    expect(replaceGrid(d, p.sessionId, GRID, null).stats).toMatchObject({ skipped: 0, ready: 2 })
  })

  it('sees the same grid imported again as exact duplicates', () => {
    const { d, acc } = db()
    const first = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: GRID, pdf: pdf() })
    expect(commit(d, first.sessionId, false).imported).toBe(2)
    expect(analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: GRID, pdf: pdf() }).stats).toMatchObject({ duplicates: 2, ready: 0 })
  })

  it('remembers a PDF layout apart from a CSV one', () => {
    const { d, acc } = db()
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: GRID, pdf: pdf() })
    commit(d, p.sessionId, true)
    const signatures = (d.prepare('SELECT header_signature FROM csv_profiles').all() as { header_signature: string }[]).map((r) => r.header_signature)
    expect(signatures).toEqual(['pdf|datum|omschrijving|bedrag|saldo'])
    expect(analyzeGrid(d, { fileName: 'b.pdf', accountId: acc, grid: GRID, pdf: pdf() }).mappingSource).toBe('saved')
    const csv = 'Datum;Omschrijving;Bedrag;Saldo\n03-10-2026;Albert Heijn;-23,45;976,55\n05-10-2026;Werkgever BV;2.500,00;3.476,55\n'
    expect(analyze(d, { fileName: 'a.csv', accountId: acc, bytes: new TextEncoder().encode(csv) }).mappingSource).toBe('detected')
  })

  it('records the printed closing balance when the table has no balance column', () => {
    const { d, acc } = db()
    const grid = GRID.map((r) => r.slice(0, 3))
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid, pdf: pdf() })
    expect(commitSummary(d, p.sessionId).closing).toEqual({ date: '2026-10-31', cents: 347655 })
    expect(commit(d, p.sessionId, false).bankBalance).toMatchObject({ date: '2026-10-31', balanceCents: 347655 })
    // Without a printed period, the last booking date.
    const q = analyzeGrid(d, { fileName: 'b.pdf', accountId: acc, grid: [...grid, ['07-10-2026', 'Extra', '-1,00']], pdf: pdf({ period: { from: null, to: null } }) })
    expect(commitSummary(d, q.sessionId).closing).toEqual({ date: '2026-10-07', cents: 347655 })
    // Nothing printed: nothing recorded.
    const r = analyzeGrid(d, { fileName: 'c.pdf', accountId: acc, grid, pdf: pdf({ balances: { opening: null, closing: null } }) })
    expect(commitSummary(d, r.sessionId).closing).toBeNull()
  })

  it('flags a running balance that does not follow, without blocking the row', () => {
    const { d, acc } = db()
    const grid = [GRID[0]!, GRID[1]!, ['05-10-2026', 'Werkgever BV', '2.500,00', '3.000,00']]
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid, pdf: pdf({ balances: { opening: 100000, closing: 300000 } }) })
    expect(p.rows.map((r) => [r.status, r.issues])).toEqual([['ready', []], ['ready', ['balance_mismatch']]])
    expect(p.stats.problems).toBe(0)
    expect(p.pdf!.reconciliation).toMatchObject({ runningMismatches: 1, differenceCents: -47655 })
    // The person skips the row: it no longer counts.
    const skipped = updateRows(d, p.sessionId, [{ index: 1, decided: 'skip' }])
    expect(skipped.pdf!.reconciliation).toMatchObject({ runningMismatches: 0, rowsChecked: 1 })
  })

  it('has no PDF data for a CSV file, and refuses PDF bytes in the CSV flow', () => {
    const { d, acc } = db()
    const csv = 'Datum;Omschrijving;Bedrag\n03-10-2026;Albert Heijn;-23,45\n'
    const p = analyze(d, { fileName: 'a.csv', accountId: acc, bytes: new TextEncoder().encode(csv) })
    expect(p).toMatchObject({ fileKind: 'csv', pdf: null })
    expect(sessionKind(p.sessionId)).toBe('csv')
    expect(pdfLines(p.sessionId)).toEqual([])
    expect(errorCode(() => analyze(d, { fileName: 'a.pdf', accountId: acc, bytes: new TextEncoder().encode('%PDF-1.7\n1 0 obj\n') }))).toBe('import.is_pdf')
  })
})
