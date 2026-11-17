import { describe, expect, it } from 'vitest'
import { AppError } from '@core/errors'
import { extractText, PDF_LIMITS } from '@core/pdf/extract'
import { toLines } from '@core/pdf/lines'
import { readStatement } from '@core/pdf/statement'
import { makePdf } from './helpers/make-pdf'
import { OWN_IBAN, STATEMENT_PAGES as PAGES } from './helpers/statement-pdf'

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
    const read = readStatement(toLines(t), OWN_IBAN)
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

  it('stops at the first page that goes over a limit, without reading the rest', async () => {
    const progress: number[] = []
    const err = await extractText(makePdf(PAGES), (n) => progress.push(n), { ...PDF_LIMITS, maxItems: 5 }).then(
      () => null,
      (e: unknown) => e
    )
    expect((err as AppError).code).toBe('import.pdf_too_large')
    expect(progress.length).toBeLessThan(PAGES.length)
  })

  it('reads a content stream that inflates a thousandfold as a page without text', async () => {
    // 4 MiB of zeros deflates to a few KB: the page has no text, so the answer is a fixed one.
    const bytes = makePdf([{}], { flate: true, filler: 4 * 1024 * 1024 })
    expect(bytes.length).toBeLessThan(20_000)
    expect((await failure(bytes)).code).toBe('import.pdf_scanned')
  })
})
