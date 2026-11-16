import type { Reconciliation } from './types'

/** How many bytes at the start of a file are looked at to tell a PDF from a text export. */
export const SNIFF_BYTES = 1024

/** A PDF file starts with "%PDF-"; anything else is treated as a text export (CSV). */
export function fileKindOf(head: Uint8Array): 'pdf' | 'csv' {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]
  return magic.every((b, i) => head[i] === b) ? 'pdf' : 'csv'
}

/** Error codes of reading a PDF statement; the screen words each as errors.<code with "." as "_">. */
export const PDF_ERROR_CODES = ['import.not_pdf', 'import.is_pdf', 'import.pdf_password', 'import.pdf_broken', 'import.pdf_too_large', 'import.pdf_scanned', 'import.pdf_busy'] as const

/** Cancelling is the person's own choice: no message. */
export const isCancelledRead = (code: string): boolean => code === 'import.pdf_cancelled'

export type ReconciliationBanner =
  | { kind: 'none' }
  | { kind: 'ok' }
  | { kind: 'mismatch'; differenceCents: number }
  /** Does not add up, and the rows move the balance the wrong way round: probably a credit card statement. */
  | { kind: 'maybeFlip'; differenceCents: number }

/**
 * What to tell about the printed balances against the rows. Needs both balances (the difference is
 * null otherwise). The balances imply a movement of closing minus opening; when the rows' sum goes
 * the other way (this includes difference = -2 x sum, the exact mirror image), flipping the signs
 * is suggested.
 */
export function reconciliationBanner(r: Reconciliation | null): ReconciliationBanner {
  if (!r || r.differenceCents === null) return { kind: 'none' }
  if (r.differenceCents === 0) return { kind: 'ok' }
  const implied = r.differenceCents + r.sumCents
  const opposite = r.sumCents !== 0 && implied !== 0 && Math.sign(r.sumCents) !== Math.sign(implied)
  return opposite ? { kind: 'maybeFlip', differenceCents: r.differenceCents } : { kind: 'mismatch', differenceCents: r.differenceCents }
}
