import type { PdfPageSpec } from './make-pdf'

export const OWN_IBAN = 'BE68539007547034'
const XS = [40, 110, 300, 380, 460]

/** Rows of cells as text pieces in columns, top down from y = 780; empty cells are left out. */
export function statementPage(rows: string[][], top = 780): PdfPageSpec {
  return { texts: rows.flatMap((row, r) => row.flatMap((c, i) => (c ? [{ x: XS[i]!, y: top - r * 14, text: c }] : []))) }
}

export const HEADER = ['Date', 'Description', 'Debit', 'Credit', 'Balance']

/** A three-page statement of four transactions with printed opening and closing balances. */
export const STATEMENT_PAGES: PdfPageSpec[] = [
  statementPage([
    ['Statement of account'],
    [`Account ${OWN_IBAN}`],
    ['Period 01/11/2026 to 30/11/2026'],
    ['Opening balance', '1,000.00'],
    ['Closing balance', '2,912.00'],
    HEADER,
    ['03/11/2026', 'Albert Heijn Brussel', '12.50', '', '987.50']
  ]),
  statementPage([
    ['05/11/2026', 'Salary November', '', '2000.00', '2987.50'],
    ['07/11/2026', 'Proximus', '30.00', '', '2957.50']
  ]),
  statementPage([['09/11/2026', 'Delhaize', '45.50', '', '2912.00']])
]
