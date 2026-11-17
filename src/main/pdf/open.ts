import { AppError } from '@core/errors'
import type { Db } from '@core/database'
import { analyzeGrid } from '@core/import'
import { isPdf } from '@core/pdf/detect'
import { toLines, type PdfText } from '@core/pdf/lines'
import { readStatement } from '@core/pdf/statement'
import type { ImportPreview, PdfNote } from '@shared/types'

export interface OpenPdfInput {
  fileName: string
  accountId: number
  contentBase64: string
  /** Reads the text of the file (in a separate process in the app). */
  read: (bytes: Uint8Array) => Promise<PdfText>
}

/**
 * Opens an import session from a PDF statement: checks the file and the account first, reads the
 * text, finds the table of transactions and starts the session. When no table is found the session
 * still opens, with an empty grid.
 */
export async function openPdfSession(db: Db, input: OpenPdfInput): Promise<ImportPreview> {
  const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
  if (!isPdf(bytes)) throw new AppError('import.not_pdf', 'This is not a PDF file.')
  const account = db.prepare('SELECT iban FROM accounts WHERE id = ?').get(input.accountId) as { iban: string | null } | undefined
  if (!account) throw new AppError('accounts.not_found', 'Choose an account first.')

  const text = await input.read(bytes)
  const lines = toLines(text)
  const read = readStatement(lines, account.iban)
  const empty = text.pages.filter((p) => p.items.length === 0).length
  const grid = read.headerFound ? read.grid : []
  const notes: PdfNote[] = [
    ...read.notes,
    ...(empty ? [{ code: 'pages_without_text' as const, count: empty }] : []),
    // Only counts, never the text: what the person can tell the developer when a bank's PDF is not read.
    ...(grid.length ? [] : [{ code: 'no_table' as const, pages: text.pageCount, lines: lines.length }])
  ]
  return analyzeGrid(db, {
    fileName: input.fileName,
    accountId: input.accountId,
    grid,
    pdf: { lines, pages: text.pageCount, readBy: 'kasboek', balances: read.balances, period: read.period, notes }
  })
}
