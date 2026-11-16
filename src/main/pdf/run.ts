import { AppError } from '@core/errors'
import type { PdfText } from '@core/pdf/lines'
import { readerMessageSchema, type ReaderRequest } from './protocol'

/** The part of an Electron utility process that is used here (so a test can stand in for it). */
export interface ReaderChild {
  postMessage(message: ReaderRequest): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: () => void): unknown
  kill(): boolean
}

export interface ReadOptions {
  signal?: AbortSignal
  onPage?: (n: number, of: number) => void
  /** Wall-clock limit in milliseconds. */
  timeoutMs?: number
}

export const READ_TIMEOUT_MS = 60_000

let busy = false

/**
 * Reads the text of a PDF in a process of its own, one file per process, and ends that process in
 * every case. One file at a time: a second request is refused.
 */
export async function runReader(start: () => ReaderChild, bytes: Uint8Array, opts: ReadOptions = {}): Promise<PdfText> {
  if (busy) throw new AppError('import.pdf_busy', 'Another PDF is still being read. Wait a moment and try again.')
  busy = true
  let child: ReaderChild | null = null
  let timer: NodeJS.Timeout | null = null
  let onAbort: (() => void) | null = null
  try {
    return await new Promise<PdfText>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new AppError('import.pdf_cancelled', 'Reading the PDF was cancelled.'))
      child = start()
      onAbort = () => reject(new AppError('import.pdf_cancelled', 'Reading the PDF was cancelled.'))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => reject(new AppError('import.pdf_too_large', 'Reading this PDF took too long. Try a PDF of one statement.')), opts.timeoutMs ?? READ_TIMEOUT_MS)
      const crashed = (): void => reject(new AppError('import.pdf_broken', 'The PDF could not be read: the reader stopped unexpectedly. The file may be damaged or too large.'))
      child.on('exit', crashed)
      child.on('error', crashed)
      child.on('message', (raw) => {
        const parsed = readerMessageSchema.safeParse(raw)
        if (!parsed.success) return reject(new AppError('import.pdf_broken', 'The PDF could not be read: the reader gave an unusable answer.'))
        const m = parsed.data
        if ('progress' in m) opts.onPage?.(m.progress.page, m.progress.pages)
        else if (m.ok) resolve(m.result)
        else reject(new AppError(m.code, m.message))
      })
      child.postMessage({ bytes })
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    try {
      child?.kill()
    } finally {
      busy = false
    }
  }
}
