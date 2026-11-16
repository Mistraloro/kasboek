import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDF_ERROR_CODES, fileKindOf, isCancelledRead, reconciliationBanner } from '@shared/pdf-import'
import type { Reconciliation } from '@shared/types'

const rec = (p: Partial<Reconciliation>): Reconciliation => ({ openingCents: 100000, closingCents: 90000, sumCents: -10000, differenceCents: 0, rowsChecked: 3, runningMismatches: 0, ...p })
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('fileKindOf', () => {
  it('recognises a PDF by its first bytes, not its name', () => {
    expect(fileKindOf(bytes('%PDF-1.7\n%âãÏÓ'))).toBe('pdf')
  })
  it('treats text, empty and short input as CSV', () => {
    expect(fileKindOf(bytes('Date;Amount\n'))).toBe('csv')
    expect(fileKindOf(new Uint8Array())).toBe('csv')
    expect(fileKindOf(bytes('%PDF'))).toBe('csv')
    expect(fileKindOf(bytes(' %PDF-1.4'))).toBe('csv')
  })
})

describe('reconciliationBanner', () => {
  it('has nothing to say without a reconciliation or a balance', () => {
    expect(reconciliationBanner(null)).toEqual({ kind: 'none' })
    expect(reconciliationBanner(rec({ openingCents: null, differenceCents: null }))).toEqual({ kind: 'none' })
    expect(reconciliationBanner(rec({ closingCents: null, differenceCents: null }))).toEqual({ kind: 'none' })
  })
  it('is ok when the difference is zero, also for zero rows', () => {
    expect(reconciliationBanner(rec({}))).toEqual({ kind: 'ok' })
    expect(reconciliationBanner(rec({ sumCents: 0, rowsChecked: 0 }))).toEqual({ kind: 'ok' })
  })
  it('reports a plain mismatch with the difference', () => {
    // implied movement -10000, rows add up to -9000: same direction
    expect(reconciliationBanner(rec({ sumCents: -9000, differenceCents: -1000 }))).toEqual({ kind: 'mismatch', differenceCents: -1000 })
  })
  it('suggests flipping when the rows are the exact mirror image', () => {
    // implied -10000, rows +10000: difference = -2 x sum
    expect(reconciliationBanner(rec({ sumCents: 10000, differenceCents: -20000 }))).toEqual({ kind: 'maybeFlip', differenceCents: -20000 })
  })
  it('suggests flipping when the rows go the opposite way, not exactly mirrored', () => {
    expect(reconciliationBanner(rec({ sumCents: 8000, differenceCents: -18000 }))).toEqual({ kind: 'maybeFlip', differenceCents: -18000 })
  })
  it('does not suggest flipping with no rows or no implied movement', () => {
    expect(reconciliationBanner(rec({ sumCents: 0, differenceCents: -10000 }))).toEqual({ kind: 'mismatch', differenceCents: -10000 })
    expect(reconciliationBanner(rec({ openingCents: 5000, closingCents: 5000, sumCents: 700, differenceCents: -700 }))).toEqual({ kind: 'mismatch', differenceCents: -700 })
  })
})

describe('PDF error texts', () => {
  const en = JSON.parse(readFileSync('src/renderer/src/i18n/locales/en.json', 'utf8')) as { errors: Record<string, string> }
  it('has a friendly English text for every code that is shown', () => {
    for (const code of PDF_ERROR_CODES) expect(en.errors[code.replace(/\./g, '_')], code).toBeTruthy()
  })
  it('stays silent only for cancelling', () => {
    expect(isCancelledRead('import.pdf_cancelled')).toBe(true)
    for (const code of PDF_ERROR_CODES) expect(isCancelledRead(code)).toBe(false)
  })
})
