// Copied from tests/pdf-layouts.test.ts (the page builders only, exported): the invented block and turned-landscape layouts.
import type { PdfPageSpec } from '../../../../tests/helpers/make-pdf'
type Piece = NonNullable<PdfPageSpec['texts']>[number]
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
export { blockPages, turnedPages, TXS }
