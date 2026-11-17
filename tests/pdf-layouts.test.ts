/**
 * Statement layouts as bank apps and web banking print them, with invented content: a list of blocks
 * with no header (a day above its month, an amount at the right, a record cut by the page break), and
 * a table on a landscape page that is stored turned. Each goes through the real chain: PDF bytes ->
 * extractText -> toLines -> readStatement -> import session.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { analyzeGrid } from '@core/import'
import { extractText } from '@core/pdf/extract'
import { toLines, type PdfLine, type PdfText } from '@core/pdf/lines'
import { readStatement } from '@core/pdf/statement'
import { openPdfSession } from '../src/main/pdf/open'
import { makePdf, type PdfPageSpec } from './helpers/make-pdf'

type Piece = NonNullable<PdfPageSpec['texts']>[number]

function db() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-layout-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(d.prepare("INSERT INTO accounts (name, bank) VALUES ('Main', 'bank')").run().lastInsertRowid)
  return { d, acc }
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const linesOf = async (pages: PdfPageSpec[]): Promise<PdfLine[]> => toLines(await extractText(makePdf(pages)))

// ------------------------------------------------------------------------------- block layout

interface Tx {
  day: number
  month: string
  /** Description lines: the first sits beside the day and the amount, the others below it. */
  lines: string[]
  amount: string
}

/** Example IBANs that pass the check digits. */
const FAKE_IBAN = 'BE71 0961 2345 6769'
const OTHER_IBAN = 'BE68 5390 0754 7034'
const PRINT_DATE = '17.11.2026'
/** An amount whose right end is at x = 556, as far as Helvetica goes. */
const right = (text: string, size = 10.5): number => 556 - text.length * size * 0.52

/**
 * Pages of 612 x 792 with a title and a link at the top and a page count and a timestamp at the bottom
 * of every page, a balance block and the print date on the first, then one block per transaction:
 * the day left of the first description line and the amount at the right, the month under the day,
 * a second description line and an IBAN line. A block that does not fit at the bottom is cut after
 * its first line; the day, the month and the rest are at the top of the next page.
 */
function blockPages(txs: Tx[]): PdfPageSpec[] {
  const pages: Piece[][] = [[]]
  const at = (page: number, x: number, y: number, text: string, size = 10.5): void => void pages[page]!.push({ x, y, text, size })
  at(0, 527, 747, PRINT_DATE)
  at(0, 549, 690, 'Saldo')
  at(0, 36, 678, 'Voorbeeld Rekening')
  at(0, 36, 665, 'Zichtrekening')
  at(0, right('100,00 EUR'), 665, '100,00 EUR')
  at(0, 36, 651, FAKE_IBAN)
  at(0, 36, 603, 'Recent')
  let page = 0
  let y = 560
  for (const tx of txs) {
    const [first, ...rest] = tx.lines
    if (y < 60) {
      at(page, 86, y, first!)
      at(page, right(tx.amount), y, tx.amount)
      pages.push([])
      page++
      at(page, 57, 746, String(tx.day))
      at(page, 86, 746, rest[0] ?? '')
      rest.slice(1).forEach((line, i) => at(page, 86, 737 - i * 8, line))
      at(page, 56, 731, tx.month, 7.9)
      y = 704
      continue
    }
    at(page, 57, y, String(tx.day))
    at(page, 86, y, first!)
    at(page, right(tx.amount), y, tx.amount)
    at(page, 56, y - 15, tx.month, 7.9)
    rest.forEach((line, i) => at(page, 86, y - 15 - i * 8, line))
    y -= 52
    if (y < 30) {
      pages.push([])
      page++
      y = 746
    }
  }
  if (pages.at(-1)!.length === 0) pages.pop()
  return pages.map((texts, i) => ({
    width: 612,
    height: 792,
    texts: [
      { x: 0, y: 783, text: 'Transacties', size: 10 },
      { x: 344, y: 783, text: 'https://bank.example/app/transactions#/', size: 10 },
      { x: 0, y: 2, text: `${i + 1} of ${pages.length}`, size: 7 },
      { x: 539, y: 2, text: '17/11/2026, 08:36', size: 7 },
      ...texts
    ]
  }))
}

/** Made-up transactions, newest first like the app lists them; December belongs to the year before the print date. */
const TXS: Tx[] = Array.from({ length: 26 }, (_, i) => {
  const date = i < 2 ? { day: 30 - i, month: 'DEC' } : { day: 28 - Math.floor(i / 2), month: 'NOV' }
  const credit = i % 6 === 5
  return {
    ...date,
    lines: [`Voorbeeld Winkel ${i + 1}`, `Betaling testplein ${i + 1}`, ...(i % 3 === 0 ? [OTHER_IBAN] : [])],
    amount: `${credit ? '' : '-'}${i + 1},${String(i * 7 % 100).padStart(2, '0')} EUR`
  }
})
// The dates run from this month down, so the December ones sit between November ones in the list only by name.
const MONTH_NUMBER: Record<string, string> = { DEC: '12', NOV: '11' }
const isoOf = (tx: Tx): string => `${tx.month === 'DEC' ? 2025 : 2026}-${MONTH_NUMBER[tx.month]}-${String(tx.day).padStart(2, '0')}`

describe('block layout without a header', () => {
  it('reads blocks with a day above its month, a record cut by a page break, and margins on every page', async () => {
    const pages = blockPages(TXS)
    expect(pages.length).toBeGreaterThan(2)
    const read = readStatement(await linesOf(pages))
    expect(read.headerFound).toBe(true)
    expect(read.grid[0]).toEqual(['Date', 'Description', 'Amount', 'IBAN'])
    expect(read.grid).toHaveLength(TXS.length + 1)
    read.grid.slice(1).forEach((row, i) => {
      const tx = TXS[i]!
      expect(row.slice(0, 3)).toEqual([`${tx.day} ${tx.month} ${tx.month === 'DEC' ? 2025 : 2026}`, tx.lines.join(' '), tx.amount])
      expect(row[3]).toBe(tx.lines.includes(OTHER_IBAN) ? OTHER_IBAN.replace(/ /g, '') : '')
    })
    // The page margins and the balance block are neither rows nor part of one.
    expect(read.grid.flat().join(' ')).not.toMatch(/Transacties|bank\.example|08:36|Zichtrekening| of /)
    expect(read.notes).toEqual([])
  })

  it('opens an import session whose rows have the right dates and signed amounts', async () => {
    const { d, acc } = db()
    const p = await openPdfSession(d, { fileName: 'app.pdf', accountId: acc, contentBase64: b64(makePdf(blockPages(TXS))), read: (b) => extractText(b) })
    expect(p).toMatchObject({ fileKind: 'pdf', stats: { total: TXS.length, ready: TXS.length }, pdf: { tableFound: true, notes: [] } })
    expect(p.rows.map((r) => r.bookingDate)).toEqual(TXS.map(isoOf))
    expect(p.rows.map((r) => r.amountCents)).toEqual(TXS.map((t) => (t.amount.startsWith('-') ? -1 : 1) * Number(t.amount.replace(/[^\d,]/g, '').replace(',', ''))))
  })

  it('keeps balance lines out of the blocks and reconciles with them', async () => {
    const pages = blockPages(TXS.slice(0, 4))
    const total = TXS.slice(0, 4).reduce((n, t) => n + (t.amount.startsWith('-') ? -1 : 1) * Number(t.amount.replace(/[^\d,]/g, '').replace(',', '')), 0)
    const closing = 100000 + total
    const money = (cents: number): string => `${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')}`
    pages[0]!.texts!.push(
      { x: 86, y: 625, text: 'Beginsaldo', size: 10.5 },
      { x: right('1000,00 EUR'), y: 625, text: '1000,00 EUR', size: 10.5 },
      { x: 86, y: 10, text: 'Eindsaldo', size: 10.5 },
      { x: right(`${money(closing)} EUR`), y: 10, text: `${money(closing)} EUR`, size: 10.5 }
    )
    const read = readStatement(await linesOf(pages))
    expect(read.balances).toEqual({ opening: 100000, closing })
    expect(read.grid).toHaveLength(5)
    const { d, acc } = db()
    const p = analyzeGrid(d, { fileName: 'a.pdf', accountId: acc, grid: read.grid, pdf: { lines: [], pages: 1, readBy: 'kasboek', balances: read.balances, period: read.period, notes: [] } })
    expect(p.pdf!.reconciliation).toMatchObject({ differenceCents: 0, rowsChecked: 4, runningMismatches: 0 })
  })

  it('does not guess when the amounts carry no sign', async () => {
    const unsigned = TXS.slice(0, 6).map((t) => ({ ...t, amount: t.amount.replace('-', '') }))
    const read = readStatement(await linesOf(blockPages(unsigned)))
    expect(read.grid).toEqual([])
  })

  it('reads a running balance printed after each amount', () => {
    const items = (rows: string[][]): PdfText['pages'][number] => ({
      n: 1,
      width: 595,
      height: 842,
      items: rows.flatMap((r, i) => [
        { str: r[0]!, x: 40, y: 700 - i * 30, w: 60, h: 10 },
        { str: r[1]!, x: 120, y: 700 - i * 30, w: 90, h: 10 },
        { str: r[2]!, x: 400, y: 700 - i * 30, w: 40, h: 10 },
        { str: r[3]!, x: 480, y: 700 - i * 30, w: 40, h: 10 }
      ])
    })
    const read = readStatement(toLines({ pages: [items([['03/11/2026', 'Eerste', '-10,00', '90,00'], ['04/11/2026', 'Tweede', '-5,00', '85,00']])], pageCount: 1 }))
    expect(read.grid).toEqual([['Date', 'Description', 'Amount', 'Balance'], ['03/11/2026', 'Eerste', '-10,00', '90,00'], ['04/11/2026', 'Tweede', '-5,00', '85,00']])
  })
})

// --------------------------------------------------------------------- landscape page stored turned

const HEADER_XS = [34, 84, 184, 335, 485, 535, 736]
const PAGE_ROWS = 10

/**
 * Landscape pages (842 x 595 as shown) stored as portrait pages with /Rotate 90, the text drawn
 * upward: a header whose first label goes on a second line, rows of a number, a type, two names, a date,
 * a message and an amount, each with an IBAN line below, and the print date and a note in the margins.
 */
function turnedPages(count: number, rowsPerPage = PAGE_ROWS): { pages: PdfPageSpec[]; rows: string[][] } {
  const rows: string[][] = []
  const pages: PdfPageSpec[] = []
  const shown = (texts: Piece[], x: number, y: number, text: string, size = 7): void => void texts.push({ x: 595 - y, y: x, text, size, turned: true })
  for (let p = 0; p < count; p++) {
    const texts: Piece[] = []
    shown(texts, 761, 545, PRINT_DATE)
    shown(texts, 30, 35, 'Voorbeeldnota: dit is verzonnen tekst.')
    shown(texts, 800, 35, String(p + 1))
    if (p === 0) {
      shown(texts, 34, 476, 'Rekeningnummer')
      shown(texts, 34, 449, FAKE_IBAN)
      shown(texts, 34, 348, 'Periode 01/11/2026 tot 17/11/2026')
    } else {
      ;['Volgnum', 'Type verrichting', 'Van', 'Naar', 'Datum', 'Mededeling', 'Bedrag'].forEach((label, i) => shown(texts, HEADER_XS[i]!, 476, label))
      shown(texts, 34, 467, 'mer')
      for (let r = 0; r < rowsPerPage; r++) {
        const n = rows.length + 1
        const y = 440 - r * 34
        const row = [`2026-${String(n).padStart(5, '0')}`, 'Overschrijving online', 'Voorbeeld Eigenaar', `Test Bakker ${n}`, `${String(1 + (n % 28)).padStart(2, '0')}/11/2026`, n % 4 === 0 ? `Factuur ${n}` : '', `${n % 5 === 0 ? '' : '-'}${n},${String(n * 3 % 100).padStart(2, '0')} EUR`]
        rows.push(row)
        ;[0, 1, 2, 3, 4, 5, 6].forEach((c) => row[c] && shown(texts, HEADER_XS[c]!, y, row[c]!))
        shown(texts, 184, y - 7, FAKE_IBAN)
        shown(texts, 335, y - 7, OTHER_IBAN)
      }
    }
    pages.push({ width: 595, height: 842, rotate: 90, texts })
  }
  return { pages, rows }
}

describe('landscape table on a turned page', () => {
  it('reads the text as it is shown, so the table has its columns', async () => {
    const { pages, rows } = turnedPages(3)
    const t = await extractText(makePdf(pages))
    expect(t.pages[1]).toMatchObject({ width: 842, height: 595 })
    const read = readStatement(toLines(t))
    expect(read.headerFound).toBe(true)
    expect(read.grid[0]).toEqual(['Volgnum mer', 'Type verrichting', 'Van', 'Naar', 'Datum', 'Mededeling', 'Bedrag', 'IBAN'])
    expect(read.grid).toHaveLength(rows.length + 1)
    read.grid.slice(1).forEach((row, i) => {
      const expected = rows[i]!
      expect([row[0], row[1], row[4], row[6]]).toEqual([expected[0], expected[1], expected[4], expected[6]])
      expect(row[3]).toContain(expected[3])
      expect(row[5]).toBe(expected[5])
    })
    // Page numbers, notes and the print date are in the margins of every page.
    expect(read.droppedLines).toBe(0)
  })

  it('maps the columns and has every row ready', async () => {
    const { pages, rows } = turnedPages(3)
    const { d, acc } = db()
    const p = await openPdfSession(d, { fileName: 'web.pdf', accountId: acc, contentBase64: b64(makePdf(pages)), read: (b) => extractText(b) })
    expect(p).toMatchObject({ stats: { total: rows.length, ready: rows.length }, pdf: { tableFound: true, pages: 3 } })
    expect(p.rows.map((r) => r.bookingDate)).toEqual(rows.map((r) => `2026-11-${r[4]!.slice(0, 2)}`))
    expect(p.rows.map((r) => r.amountCents)).toEqual(rows.map((r) => (r[6]!.startsWith('-') ? -1 : 1) * Number(r[6]!.replace(/[^\d,]/g, '').replace(',', ''))))
  })

  it('reads the largest document quickly', async () => {
    const { pages, rows } = turnedPages(71)
    const t = await extractText(makePdf(pages))
    const started = performance.now()
    const read = readStatement(toLines(t))
    const ms = performance.now() - started
    expect(read.grid).toHaveLength(rows.length + 1)
    expect(read.droppedLines).toBe(0)
    expect(ms).toBeLessThan(2000)
  }, 60_000)
})

// ------------------------------------------------------------- margins, wrapped labels, no table

const flat = (rows: [number, string][][], n: number, top = 800): PdfText['pages'][number] => ({
  n,
  width: 595,
  height: 842,
  items: rows.flatMap((row, r) => row.map(([x, str]) => ({ str, x, y: top - r * 12, w: str.length * 5, h: 10 })))
})

describe('page margins and long documents', () => {
  const HEAD: [number, string][] = [[40, 'Datum'], [110, 'Omschrijving'], [400, 'Bedrag']]
  const statement = (pages: number, rowsPerPage: number): PdfText => {
    let n = 0
    return {
      pageCount: pages,
      pages: Array.from({ length: pages }, (_, p) => {
        const rows: [number, string][][] = [[[40, 'Rekeningafschrift van Voorbeeld']], HEAD]
        for (let r = 0; r < rowsPerPage; r++) {
          n++
          rows.push([[40, `${String(1 + (n % 28)).padStart(2, '0')}/11/2026`], [110, `Betaling ${n}`], [400, `-${n},00`]])
        }
        const page = flat(rows, p + 1)
        // Page footers sit in the bottom margin, in the description column and close to the last row.
        page.items.push({ str: `Pagina ${p + 1} van ${pages}`, x: 110, y: 30, w: 80, h: 10 })
        return page
      })
    }
  }

  it('leaves repeated titles, headers and page footers out of the rows', () => {
    const read = readStatement(toLines(statement(3, 5)))
    expect(read.grid).toHaveLength(16)
    expect(read.grid.slice(1).map((r) => r[1])).toEqual(Array.from({ length: 15 }, (_, i) => `Betaling ${i + 1}`))
    expect(read.droppedLines).toBe(0)
  })

  it('stays fast on thousands of lines', () => {
    const t = statement(71, 60)
    const lines = toLines(t)
    expect(lines.length).toBeGreaterThan(4000)
    const started = performance.now()
    const read = readStatement(lines)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(read.grid).toHaveLength(71 * 60 + 1)
    // The same lines as blocks, without the header.
    const blocks = lines.filter((l) => l.cells[0]!.text !== 'Datum')
    const startedBlocks = performance.now()
    const asBlocks = readStatement(blocks)
    expect(performance.now() - startedBlocks).toBeLessThan(2000)
    expect(asBlocks.grid).toHaveLength(71 * 60 + 1)
  })

  it('reports counts, and nothing of the text, when no table is found', async () => {
    const { d, acc } = db()
    const bytes = makePdf([{ texts: [{ x: 40, y: 700, text: 'Welkom bij de bank van niemand' }, { x: 40, y: 680, text: 'Er staat hier geen tabel in dit document' }] }])
    const p = await openPdfSession(d, { fileName: 'a.pdf', accountId: acc, contentBase64: b64(bytes), read: (b) => extractText(b) })
    expect(p.pdf).toMatchObject({ tableFound: false, notes: [{ code: 'no_table', pages: 1, lines: 2 }] })
  })
})
