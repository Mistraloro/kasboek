/**
 * Reads the text of a PDF with pdf.js, page by page, within fixed limits. Meant to run in a
 * separate process (see src/main/pdf): a PDF is untrusted input and pdf.js is a large parser.
 */
import { getDocument, InvalidPDFException, PasswordException, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { AppError } from '../errors'
import type { PdfText, PdfTextItem } from './lines'

export const PDF_LIMITS = { maxPages: 150, maxItems: 300_000, maxChars: 3_000_000 }

/** Fewer characters per page than this on average: a scan or a picture, not text. */
const MIN_CHARS_PER_PAGE = 20

const tooLarge = (): AppError => new AppError('import.pdf_too_large', 'This PDF is too large or too complex to read. Try a PDF of one statement.')

/** pdf.js runs its parser in this thread when it finds the worker module here, so no worker file is needed. */
function useInlineWorker(): void {
  ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker
}

function mapError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if (err instanceof PasswordException) return new AppError('import.pdf_password', 'This PDF is protected with a password. Remove the protection and try again.')
  if (err instanceof InvalidPDFException) return new AppError('import.pdf_broken', 'This PDF could not be read. The file may be damaged.')
  return new AppError('import.pdf_broken', 'This PDF could not be read. The file may be damaged or not a PDF.')
}

/** The text of every page as positioned pieces. Pages without text are kept, with no items. */
export async function extractText(bytes: Uint8Array, onPage?: (n: number, of: number) => void, limits = PDF_LIMITS): Promise<PdfText> {
  useInlineWorker()
  // pdf.js takes ownership of the buffer it is given: pass a copy.
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: VerbosityLevel.ERRORS
  })
  try {
    const doc = await task.promise
    if (doc.numPages > limits.maxPages) throw tooLarge()
    const pages: PdfText['pages'] = []
    let items = 0
    let chars = 0
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const [x0 = 0, y0 = 0, x1 = 595, y1 = 842] = page.view
      const found: PdfTextItem[] = []
      const reader = page.streamTextContent().getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const item of value.items) {
          if (!('str' in item) || item.str === '') continue
          items++
          chars += item.str.length
          if (items > limits.maxItems || chars > limits.maxChars) throw tooLarge()
          const [a = 0, b = 0, , , e = 0, f = 0] = item.transform as number[]
          found.push({ str: item.str, x: e, y: f, w: item.width, h: item.height || Math.hypot(a, b) })
        }
      }
      page.cleanup()
      pages.push({ n, width: x1 - x0, height: y1 - y0, items: found })
      onPage?.(n, doc.numPages)
    }
    if (chars === 0 || chars / doc.numPages < MIN_CHARS_PER_PAGE) {
      throw new AppError('import.pdf_scanned', 'This PDF has no text to read (it looks like a scan or a picture). Download the statement as a PDF from your bank instead.')
    }
    return { pages, pageCount: doc.numPages }
  } catch (err) {
    throw mapError(err)
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
