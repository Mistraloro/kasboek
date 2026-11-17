import { z } from 'zod'
import { PDF_LIMITS } from '@core/pdf/limits'
import type { PdfText } from '@core/pdf/lines'

/** What the reader process is sent. */
export interface ReaderRequest {
  bytes: Uint8Array
}

export const READER_ERROR_CODES = ['import.pdf_password', 'import.pdf_broken', 'import.pdf_too_large', 'import.pdf_scanned'] as const

/** What the reader process answers. It is a separate process reading an untrusted file, so its answers are checked like any input. */
export type ReaderMessage =
  | { progress: { page: number; pages: number } }
  | { ok: true; result: PdfText }
  | { ok: false; code: (typeof READER_ERROR_CODES)[number]; message: string }

const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && v >= min && v <= max
const isInt = (v: unknown, min: number, max: number): v is number => inRange(v, min, max) && Number.isInteger(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Checks what the reader sends back by hand: a statement can hold tens of thousands of pieces and
 * a schema library is several times slower on that, on the main thread. The cheap checks (counts)
 * come first, so an oversized answer is refused before any piece is looked at. Same rules as a
 * strict schema: exactly these fields, finite numbers in range.
 */
export function isPdfText(v: unknown): v is PdfText {
  if (!isRecord(v) || Object.keys(v).length !== 2 || !isInt(v['pageCount'], 1, PDF_LIMITS.maxPages)) return false
  const pages = v['pages']
  if (!Array.isArray(pages) || pages.length > PDF_LIMITS.maxPages) return false
  let items = 0
  for (const p of pages) {
    if (!isRecord(p) || !Array.isArray(p['items'])) return false
    items += p['items'].length
  }
  if (items > PDF_LIMITS.maxItems) return false
  let chars = 0
  for (const p of pages as Record<string, unknown>[]) {
    if (Object.keys(p).length !== 4 || !isInt(p['n'], 1, PDF_LIMITS.maxPages) || !inRange(p['width'], 0, 1e7) || !inRange(p['height'], 0, 1e7)) return false
    for (const i of p['items'] as unknown[]) {
      if (!isRecord(i) || Object.keys(i).length !== 5) return false
      const str = i['str']
      if (typeof str !== 'string' || !inRange(i['x'], -1e7, 1e7) || !inRange(i['y'], -1e7, 1e7) || !inRange(i['w'], -1e7, 1e7) || !inRange(i['h'], -1e7, 1e7)) return false
      chars += str.length
    }
    if (chars > PDF_LIMITS.maxChars) return false
  }
  return true
}

const result = z.custom<PdfText>(isPdfText)

export const readerMessageSchema = z.union([
  z.object({ progress: z.object({ page: z.number().int().min(1).max(PDF_LIMITS.maxPages), pages: z.number().int().min(1).max(PDF_LIMITS.maxPages) }).strict() }).strict(),
  z.object({ ok: z.literal(true), result }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(READER_ERROR_CODES), message: z.string().max(500) }).strict()
])
