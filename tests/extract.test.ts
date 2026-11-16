import { describe, expect, it } from 'vitest'
import { AppError } from '@core/errors'
import { extractText, PDF_LIMITS } from '@core/pdf/extract'
import { toLines } from '@core/pdf/lines'
import { readStatement } from '@core/pdf/statement'
import { makePdf, type PdfPageSpec } from './helpers/make-pdf'

const OWN = 'BE68539007547034'
const XS = [40, 110, 300, 380, 460]

/** A header and rows as text pieces in columns, top down from y = 780. */
function statementPage(rows: string[][], top = 780): PdfPageSpec {
  return { texts: rows.flatMap((row, r) => row.flatMap((c, i) => (c ? [{ x: XS[i]!, y: top - r * 14, text: c }] : []))) }
}

const HEADER = ['Date', 'Description', 'Debit', 'Credit', 'Balance']
const PAGES = [
  statementPage([['Statement of account'], [`Account ${OWN}`], ['Period 01/11/2026 to 30/11/2026'], ['Opening balance', '1,000.00'], ['Closing balance', '2,912.00'], HEADER, ['03/11/2026', 'Albert Heijn Brussel', '12.50', '', '987.50']]),
  statementPage([['05/11/2026', 'Salary November', '', '2000.00', '2987.50'], ['07/11/2026', 'Proximus', '30.00', '', '2957.50']]),
  statementPage([['09/11/2026', 'Delhaize', '45.50', '', '2912.00']])
]

async function failure(bytes: Uint8Array, limits?: typeof PDF_LIMITS): Promise<AppError> {
  const err = await extractText(bytes, undefined, limits).then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(AppError)
  return err as AppError
}

describe('extractText', () => {
  it('reads items with their positions, page by page, and reports progress', async () => {
    const progress: [number, number][] = []
    const t = await extractText(makePdf(PAGES), (n, of) => progress.push([n, of]))
    expect(t.pageCount).toBe(3)
    expect(t.pages.map((p) => p.n)).toEqual([1, 2, 3])
    expect(t.pages[0]).toMatchObject({ width: 595, height: 842 })
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
    const heijn = t.pages[0]!.items.find((i) => i.str.startsWith('Albert'))!
    expect(heijn.x).toBeCloseTo(110)
    expect(heijn.y).toBeCloseTo(780 - 6 * 14)
    expect(heijn.h).toBeCloseTo(9)
    expect(heijn.w).toBeGreaterThan(40)
  })

  it('gives a grid that the statement reader understands', async () => {
    const t = await extractText(makePdf(PAGES))
    const read = readStatement(toLines(t), OWN)
    expect(read.headerFound).toBe(true)
    expect(read.grid).toHaveLength(5)
    expect(read.grid.map((r) => r.join('|')).join('\n')).toContain('Salary November')
    expect(read.balances).toEqual({ opening: 100000, closing: 291200 })
  })

  it('reads compressed content streams the same way', async () => {
    const plain = await extractText(makePdf(PAGES))
    const flate = await extractText(makePdf(PAGES, { flate: true }))
    expect(flate).toEqual(plain)
  })

  it('refuses a truncated file as broken', async () => {
    const bytes = makePdf(PAGES)
    expect((await failure(bytes.slice(0, Math.floor(bytes.length / 2)))).code).toBe('import.pdf_broken')
    expect((await failure(new TextEncoder().encode('%PDF-1.4 nothing else'))).code).toBe('import.pdf_broken')
  })

  it('refuses a PDF without text as scanned', async () => {
    expect((await failure(makePdf([{}, {}]))).code).toBe('import.pdf_scanned')
    expect((await failure(makePdf([{ texts: [{ x: 10, y: 10, text: 'Page 1' }] }]))).code).toBe('import.pdf_scanned')
  })

  it('keeps pages without text when other pages have text', async () => {
    const t = await extractText(makePdf([PAGES[0]!, {}, PAGES[1]!]))
    expect(t.pages.map((p) => p.items.length > 0)).toEqual([true, false, true])
  })

  it('asks for the password of an encrypted file', async () => {
    expect((await failure(makePdf(PAGES, { encrypted: true }))).code).toBe('import.pdf_password')
  })

  it('stops at the limits', async () => {
    const bytes = makePdf(PAGES)
    expect((await failure(bytes, { ...PDF_LIMITS, maxPages: 2 })).code).toBe('import.pdf_too_large')
    expect((await failure(bytes, { ...PDF_LIMITS, maxItems: 5 })).code).toBe('import.pdf_too_large')
    expect((await failure(bytes, { ...PDF_LIMITS, maxChars: 40 })).code).toBe('import.pdf_too_large')
    const many = makePdf(Array.from({ length: PDF_LIMITS.maxPages + 1 }, () => ({})))
    expect((await failure(many)).code).toBe('import.pdf_too_large')
  })

  it('does not hang on a content stream that inflates to a huge size', async () => {
    const started = Date.now()
    const outcome = await extractText(makePdf([{}], { flate: true, filler: 64 * 1024 * 1024 })).then(
      () => 'result',
      (e: unknown) => (e as AppError).code
    )
    expect(['result', 'import.pdf_scanned', 'import.pdf_broken', 'import.pdf_too_large']).toContain(outcome)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 25_000)
})
