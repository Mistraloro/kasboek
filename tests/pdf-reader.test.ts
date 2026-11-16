import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { AppError } from '@core/errors'
import { extractText, PDF_LIMITS } from '@core/pdf/extract'
import type { PdfText } from '@core/pdf/lines'
import { readerMessageSchema } from '../src/main/pdf/protocol'
import { runReader, type ReaderChild } from '../src/main/pdf/run'
import { openPdfSession } from '../src/main/pdf/open'
import { makePdf } from './helpers/make-pdf'
import { OWN_IBAN, STATEMENT_PAGES } from './helpers/statement-pdf'

const text = (items = 1): PdfText => ({ pageCount: 1, pages: [{ n: 1, width: 595, height: 842, items: Array.from({ length: items }, () => ({ str: 'a', x: 1, y: 2, w: 3, h: 4 })) }] })
const valid = (t: PdfText) => readerMessageSchema.safeParse({ ok: true, result: t }).success

describe('reader messages', () => {
  it('accepts progress, a result and a failure', () => {
    expect(readerMessageSchema.safeParse({ progress: { page: 1, pages: 3 } }).success).toBe(true)
    expect(valid(text())).toBe(true)
    expect(readerMessageSchema.safeParse({ ok: false, code: 'import.pdf_scanned', message: 'No text.' }).success).toBe(true)
  })

  it('rejects numbers that are not finite or out of range', () => {
    const bad = (item: object) => valid({ pageCount: 1, pages: [{ n: 1, width: 595, height: 842, items: [{ str: 'a', x: 1, y: 2, w: 3, h: 4, ...item }] }] })
    expect(bad({ x: NaN })).toBe(false)
    expect(bad({ y: Infinity })).toBe(false)
    expect(bad({ w: 1e12 })).toBe(false)
    expect(readerMessageSchema.safeParse({ progress: { page: 0, pages: 3 } }).success).toBe(false)
    expect(readerMessageSchema.safeParse({ progress: { page: 1.5, pages: 3 } }).success).toBe(false)
    expect(valid({ pageCount: PDF_LIMITS.maxPages + 1, pages: [] })).toBe(false)
  })

  it('rejects too much text', () => {
    expect(valid(text(PDF_LIMITS.maxItems))).toBe(true)
    expect(valid(text(PDF_LIMITS.maxItems + 1))).toBe(false)
    const long = (n: number) => ({ str: 'a'.repeat(n), x: 1, y: 2, w: 3, h: 4 })
    expect(valid({ pageCount: 1, pages: [{ n: 1, width: 1, height: 1, items: [long(PDF_LIMITS.maxChars + 1)] }] })).toBe(false)
    // Each piece is allowed, together they are not.
    expect(valid({ pageCount: 1, pages: [{ n: 1, width: 1, height: 1, items: [long(2_000_000), long(2_000_000)] }] })).toBe(false)
  })

  it('rejects unknown fields, unknown error codes and long messages', () => {
    expect(readerMessageSchema.safeParse({ ok: true, result: text(), extra: 1 }).success).toBe(false)
    expect(readerMessageSchema.safeParse({ ok: false, code: 'auth.locked', message: 'x' }).success).toBe(false)
    expect(readerMessageSchema.safeParse({ ok: false, code: 'import.pdf_broken', message: 'x'.repeat(501) }).success).toBe(false)
    expect(readerMessageSchema.safeParse('hello').success).toBe(false)
  })
})

/** Stands in for the utility process: answers each request with what the script says. */
class FakeChild extends EventEmitter implements ReaderChild {
  killed = 0
  requests: Uint8Array[] = []
  constructor(private readonly script: (child: FakeChild) => void) {
    super()
  }
  postMessage(message: { bytes: Uint8Array }): void {
    this.requests.push(message.bytes)
    queueMicrotask(() => this.script(this))
  }
  kill(): boolean {
    this.killed++
    return true
  }
}

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as AppError).code
  )

describe('runReader', () => {
  it('returns the result, passes progress on and ends the process', async () => {
    const child = new FakeChild((c) => {
      c.emit('message', { progress: { page: 1, pages: 2 } })
      c.emit('message', { progress: { page: 2, pages: 2 } })
      c.emit('message', { ok: true, result: text() })
    })
    const seen: [number, number][] = []
    const bytes = new Uint8Array([1, 2, 3])
    expect(await runReader(() => child, bytes, { onPage: (n, of) => seen.push([n, of]) })).toEqual(text())
    expect(seen).toEqual([[1, 2], [2, 2]])
    expect(child.requests).toEqual([bytes])
    expect(child.killed).toBe(1)
  })

  it('turns a failure of the reader into the same error and ends the process', async () => {
    const child = new FakeChild((c) => c.emit('message', { ok: false, code: 'import.pdf_password', message: 'Password.' }))
    expect(await code(runReader(() => child, new Uint8Array(1)))).toBe('import.pdf_password')
    expect(child.killed).toBe(1)
  })

  it('does not trust a message of the wrong shape', async () => {
    const child = new FakeChild((c) => c.emit('message', { ok: true, result: text(PDF_LIMITS.maxItems + 1) }))
    expect(await code(runReader(() => child, new Uint8Array(1)))).toBe('import.pdf_broken')
    expect(child.killed).toBe(1)
  })

  it('reports a crashed process as broken and ends it', async () => {
    const child = new FakeChild((c) => c.emit('exit', 134))
    expect(await code(runReader(() => child, new Uint8Array(1)))).toBe('import.pdf_broken')
    expect(child.killed).toBe(1)
  })

  it('stops a reader that takes too long', async () => {
    const child = new FakeChild(() => undefined)
    expect(await code(runReader(() => child, new Uint8Array(1), { timeoutMs: 20 }))).toBe('import.pdf_too_large')
    expect(child.killed).toBe(1)
  })

  it('cancels on abort and ends the process', async () => {
    const child = new FakeChild(() => undefined)
    const controller = new AbortController()
    const running = code(runReader(() => child, new Uint8Array(1), { signal: controller.signal }))
    controller.abort()
    expect(await running).toBe('import.pdf_cancelled')
    expect(child.killed).toBe(1)
  })

  it('does not start a process when already cancelled', async () => {
    let started = 0
    const controller = new AbortController()
    controller.abort()
    expect(
      await code(
        runReader(
          () => {
            started++
            return new FakeChild(() => undefined)
          },
          new Uint8Array(1),
          { signal: controller.signal }
        )
      )
    ).toBe('import.pdf_cancelled')
    expect(started).toBe(0)
  })

  it('reads one file at a time and is free again afterwards', async () => {
    const first = new FakeChild(() => undefined)
    const running = runReader(() => first, new Uint8Array(1))
    let started = 0
    expect(
      await code(
        runReader(
          () => {
            started++
            return new FakeChild(() => undefined)
          },
          new Uint8Array(1)
        )
      )
    ).toBe('import.pdf_busy')
    expect(started).toBe(0)
    expect(first.killed).toBe(0)
    first.emit('message', { ok: true, result: text() })
    await running
    const next = new FakeChild((c) => c.emit('message', { ok: true, result: text() }))
    expect(await runReader(() => next, new Uint8Array(1))).toEqual(text())
  })
})

describe('openPdfSession', () => {
  function db() {
    const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-pdfop-')), 'k.db'), randomBytes(32).toString('hex'))
    const acc = Number(d.prepare("INSERT INTO accounts (name, bank, iban) VALUES ('Main', 'bank', ?)").run(OWN_IBAN).lastInsertRowid)
    return { d, acc }
  }
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

  it('checks the file and the account before reading anything', async () => {
    const { d, acc } = db()
    let reads = 0
    const read = async (bytes: Uint8Array) => {
      reads++
      return extractText(bytes)
    }
    expect(await code(openPdfSession(d, { fileName: 'a.pdf', accountId: acc, contentBase64: b64(new TextEncoder().encode('a,b\n1,2\n')), read }))).toBe('import.not_pdf')
    expect(await code(openPdfSession(d, { fileName: 'a.pdf', accountId: acc + 1, contentBase64: b64(makePdf(STATEMENT_PAGES)), read }))).toBe('accounts.not_found')
    expect(reads).toBe(0)
  })

  it('reads, finds the table and opens a session with balances', async () => {
    const { d, acc } = db()
    const p = await openPdfSession(d, { fileName: 'a.pdf', accountId: acc, contentBase64: b64(makePdf(STATEMENT_PAGES)), read: (b) => extractText(b) })
    expect(p).toMatchObject({ fileKind: 'pdf', stats: { total: 4, ready: 4 }, pdf: { pages: 3, readBy: 'kasboek', tableFound: true, notes: [] } })
    expect(p.pdf?.reconciliation).toMatchObject({ rowsChecked: 4, runningMismatches: 0 })
  })

  it('notes pages without text and still opens when no table is found', async () => {
    const { d, acc } = db()
    const lines = [{ x: 40, y: 700, text: 'A letter from the bank that is not a statement at all' }]
    const p = await openPdfSession(d, { fileName: 'a.pdf', accountId: acc, contentBase64: b64(makePdf([{ texts: lines }, {}])), read: (b) => extractText(b) })
    expect(p.pdf).toMatchObject({ tableFound: false, reconciliation: null, notes: [{ code: 'pages_without_text', count: 1 }] })
    expect(p.rows).toEqual([])
  })

  it('passes errors of the read on and opens no session', async () => {
    const { d, acc } = db()
    const read = () => Promise.reject(new AppError('import.pdf_password', 'Password.'))
    expect(await code(openPdfSession(d, { fileName: 'a.pdf', accountId: acc, contentBase64: b64(makePdf(STATEMENT_PAGES)), read }))).toBe('import.pdf_password')
  })
})
