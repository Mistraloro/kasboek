import { z } from 'zod'
import { PDF_LIMITS } from '@core/pdf/extract'
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

const coordinate = z.number().min(-1e7).max(1e7)
const item = z.object({ str: z.string().max(PDF_LIMITS.maxChars), x: coordinate, y: coordinate, w: coordinate, h: coordinate }).strict()
const page = z
  .object({
    n: z.number().int().min(1).max(PDF_LIMITS.maxPages),
    width: z.number().min(0).max(1e7),
    height: z.number().min(0).max(1e7),
    items: z.array(item).max(PDF_LIMITS.maxItems)
  })
  .strict()
const result = z
  .object({ pages: z.array(page).max(PDF_LIMITS.maxPages), pageCount: z.number().int().min(1).max(PDF_LIMITS.maxPages) })
  .strict()
  .superRefine((t, ctx) => {
    const items = t.pages.reduce((n, p) => n + p.items.length, 0)
    const chars = t.pages.reduce((n, p) => n + p.items.reduce((m, i) => m + i.str.length, 0), 0)
    if (items > PDF_LIMITS.maxItems || chars > PDF_LIMITS.maxChars) ctx.addIssue({ code: 'custom', message: 'Too much text.' })
  })

export const readerMessageSchema = z.union([
  z.object({ progress: z.object({ page: z.number().int().min(1).max(PDF_LIMITS.maxPages), pages: z.number().int().min(1).max(PDF_LIMITS.maxPages) }).strict() }).strict(),
  z.object({ ok: z.literal(true), result }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(READER_ERROR_CODES), message: z.string().max(500) }).strict()
])
