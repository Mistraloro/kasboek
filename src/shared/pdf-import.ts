import type { Reconciliation } from './types'

/** How many bytes at the start of a file are looked at to tell a PDF from a text export. */
export const SNIFF_BYTES = 1024

/**
 * A PDF file starts with "%PDF-"; a file whose first character (after a byte order mark and spaces)
 * is "<" is XML (UTF-8, or UTF-16 with a mark or a zero byte next to it); anything else is treated as
 * a text export (CSV).
 */
export function fileKindOf(head: Uint8Array): 'pdf' | 'csv' | 'xml' {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]
  if (magic.every((b, i) => head[i] === b)) return 'pdf'
  let at = 0
  let width = 1
  let low = 0 // which byte of a UTF-16 character holds the ASCII letter
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) at = 3
  else if (head[0] === 0xff && head[1] === 0xfe) [at, width] = [2, 2]
  else if (head[0] === 0xfe && head[1] === 0xff) [at, width, low] = [2, 2, 1]
  else if (head[0] !== 0 && head[1] === 0) width = 2
  else if (head[0] === 0 && head[1] !== undefined && head[1] !== 0) [width, low] = [2, 1]
  for (let i = at; i + width <= head.length; i += width) {
    const c = head[i + low]
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue
    return c === 0x3c ? 'xml' : 'csv'
  }
  return 'csv'
}

/** Error codes of reading an XML (CAMT) statement; the screen words each as errors.<code with "." as "_">. */
export const XML_ERROR_CODES = ['import.xml_not_camt', 'import.xml_broken', 'import.xml_dtd', 'import.xml_too_large', 'import.xml_version', 'import.xml_accounts', 'import.xml_iban_mismatch', 'import.xml_currency'] as const

export const PDF_ERROR_CODES = ['import.not_pdf', 'import.is_pdf', 'import.pdf_password', 'import.pdf_broken', 'import.pdf_too_large', 'import.pdf_scanned', 'import.pdf_busy', 'import.pdf_reader_unavailable'] as const

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
