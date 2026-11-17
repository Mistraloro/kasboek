import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { analyze, analyzeGrid, commit } from '@core/import'
import type { PdfLine } from '@core/pdf/lines'
import { setSecret } from '@core/secrets'
import { updateSettings } from '@core/settings'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, app: { getPath: () => tmpdir(), isPackaged: false }, BrowserWindow: { getAllWindows: () => [] }, powerMonitor: { on: vi.fn() } }))

// All data here is invented.
const OWN = 'BE68539007547034'
const OTHER = 'BE71096123456769'
const CARD = '4929123456789012'

const line = (id: number, page: number, cells: [number, string][]): PdfLine => ({ id, page, y: 800 - id * 12, pageHeight: 842, cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 })) })

/** A statement: header lines (name, address, account), the table header, then `pages` pages of two payments each. */
function statement(pages: number): PdfLine[] {
  const lines: PdfLine[] = [
    line(0, 1, [[40, 'Jan Jansen']]),
    line(1, 1, [[40, 'Main Street 1, Springfield']]),
    line(2, 1, [[40, `Account ${OWN}`]]),
    line(3, 1, [[60, 'Date'], [140, 'Description'], [400, 'Amount'], [510, 'Balance']])
  ]
  for (let p = 1; p <= pages; p++) {
    const day = String(p).padStart(2, '0')
    lines.push(line(lines.length, p, [[60, `${day}/11`], [140, `SHOP ${p} card ${CARD}`], [400, `${p},50-`], [510, '100,00']]))
    lines.push(line(lines.length, p, [[140, `Transfer to Jan Peeters ${OTHER}`]]))
    lines.push(line(lines.length, p, [[60, `${day}/11`], [140, `PAYMENT ${p}`], [400, `${p},25`], [510, '100,00']]))
  }
  return lines
}

function setup(lines: PdfLine[], balances = { opening: null as number | null, closing: null as number | null }): { db: Db; sessionId: string; accountId: number } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-pdf-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm' })
  const pages = new Set(lines.map((l) => l.page)).size
  const preview = analyzeGrid(db, {
    fileName: 'statement.pdf',
    accountId: acc,
    grid: [],
    pdf: { lines, pages, readBy: 'kasboek', balances, period: { from: '2026-11-01', to: '2026-11-30' }, notes: [{ code: 'no_table', pages, lines: lines.length }] }
  })
  return { db, sessionId: preview.sessionId, accountId: acc }
}

type Body = { messages: { role: string; content: string }[] }
const requests: Body[] = []

/** The "assistant": for every own line of a part that starts with a date, one row copied from the text. */
function answer(body: Body, tweak: (rows: Record<string, unknown>[]) => Record<string, unknown>[] = (r) => r): Response {
  const user = body.messages.find((m) => m.role === 'user')!.content
  const rows = user
    .split('\n')
    .filter((l) => /^L\d+ p/.test(l))
    .flatMap((l) => {
      const m = /^L(\d+) p\d+ \| x60 (\d\d\/\d\d) \| x140 (.+?) \| x400 (\S+) \| x510 (\S+)$/.exec(l)
      return m ? [{ lines: [Number(m[1])], date: m[2], valueDate: null, amount: m[4], direction: null, balance: m[5], counterparty: m[3] }] : []
    })
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ rows: tweak(rows), openingBalance: null, closingBalance: null, notes: ['Read it.'] }) } }] }), { status: 200 })
}

async function mockFetch(handler: (body: Body, n: number) => Response | Promise<Response>): Promise<void> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  requests.length = 0
  fetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body
    requests.push(body)
    return handler(body, requests.length)
  })
}
const userText = (b: Body): string => b.messages.find((m) => m.role === 'user')!.content
const partOf = (b: Body): number => Number(/^Part (\d+) of/.exec(userText(b))![1])

beforeEach(() => requests.splice(0))

describe('reading a PDF statement with the assistant', () => {
  it('shows exactly the masked text that is sent, and leaves out the top of the statement', async () => {
    const { pdfAssistPreview, assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(2))
    const info = pdfAssistPreview(db, sessionId)
    expect(info).toMatchObject({ pages: 2, parts: 1, preambleLeftOut: true })
    expect(info.chars).toBe(info.text.length)
    expect(info.approxTokens).toBeGreaterThan(info.chars / 4)
    // Name, address and account number above the table are not in it; numbers are masked.
    expect(info.text).not.toMatch(/Jansen|Main Street|Account/)
    expect(info.text).toContain('x140 Transfer to Jan Peeters BE…6769')
    expect(info.text).toContain('card …9012')

    await mockFetch((b) => answer(b))
    await assistPdf(db, sessionId)
    expect(requests).toHaveLength(1)
    // The request is the head line, a blank line and then that same text, line for line.
    expect(userText(requests[0]!).split('\n').slice(2).join('\n')).toBe(info.text)
  })

  it('never sends an account or card number, and brings the real account number back locally', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(5))
    await mockFetch((b) => answer(b))
    const preview = await assistPdf(db, sessionId)
    const sent = JSON.stringify(requests)
    for (const secret of [OWN, OTHER, CARD, '5390 0754', 'Jansen', 'Main Street', '4929 1234']) expect(sent).not.toContain(secret)
    expect(preview.pdf).toMatchObject({ readBy: 'assistant', tableFound: true })
    expect(preview.rows.length).toBeGreaterThan(0)
    // The amounts come from the PDF's text: "1,50-" is money out, "1,25" is money in.
    expect(preview.rows.slice(0, 2).map((r) => [r.bookingDate, r.amountCents, r.status])).toEqual([['2026-11-01', -150, 'ready'], ['2026-11-01', 125, 'ready']])
    expect(preview.notes.join(' ')).toContain('Read it.')
  })

  it('splits into parts of 4 pages, runs them side by side and merges by line id', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(9))
    // The first part answers last.
    await mockFetch(async (b) => {
      if (partOf(b) === 1) await new Promise((r) => setTimeout(r, 60))
      return answer(b)
    })
    const preview = await assistPdf(db, sessionId)
    expect(requests.map(partOf).sort()).toEqual([1, 2, 3])
    expect(requests.every((b) => /Part \d of 3/.test(userText(b)))).toBe(true)
    // Later parts carry the last lines of the part before as context only.
    expect(userText(requests.find((b) => partOf(b) === 2)!)).toContain('(context only) L')
    expect(userText(requests.find((b) => partOf(b) === 1)!)).not.toContain('(context only) L')
    expect(preview.rows.map((r) => r.bookingDate)).toEqual(Array.from({ length: 9 }, (_, i) => [`2026-11-0${i + 1}`, `2026-11-0${i + 1}`]).flat())
    expect(preview.stats.problems).toBe(0)
  })

  it('keeps the other parts when one fails, and says so', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(9))
    await mockFetch((b) => (partOf(b) === 2 ? new Response('{"message":"no"}', { status: 401 }) : answer(b)))
    const preview = await assistPdf(db, sessionId)
    expect(preview.rows).toHaveLength(2 * 4 + 2 * 1)
    expect(preview.notes.join(' ')).toMatch(/1 of 3 parts couldn’t be read \(part 2\)/)
    // Every part failing is an error, and the open import stays as it was.
    await mockFetch(() => new Response('{"message":"no"}', { status: 401 }))
    await expect(assistPdf(db, sessionId)).rejects.toThrow()
  })

  it('shows rows the text does not support as problems, with a note, instead of trusting them', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(2))
    await mockFetch((b) => answer(b, (rows) => rows.map((r, i) => (i === 0 ? { ...r, amount: '99,99-' } : r))))
    const preview = await assistPdf(db, sessionId)
    const bad = preview.rows.filter((r) => r.status === 'problem')
    expect(bad).toHaveLength(1)
    expect(bad[0]!.note).toMatch(/amount “99,99-” is not in the text/)
    expect(bad[0]!.amountCents).toBeNull()
    expect(preview.notes.join(' ')).toMatch(/1 row couldn’t be matched/)
    // The rest can still be imported; the problem row can't be.
    expect(preview.stats.ready).toBe(3)
    expect(commit(db, sessionId, false).imported).toBe(3)
  })

  it('refuses a statement of more than 40 pages, before anything is sent', async () => {
    const { assistPdf, pdfAssistPreview } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(41))
    await mockFetch((b) => answer(b))
    expect(() => pdfAssistPreview(db, sessionId)).toThrow(/at most 40 pages/)
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject({ code: 'assistant.pdf_too_long' })
    expect(requests).toHaveLength(0)
    // 40 pages is fine.
    const ok = setup(statement(40))
    expect(pdfAssistPreview(ok.db, ok.sessionId)).toMatchObject({ pages: 40, parts: 10 })
  })

  it('asks for a configured assistant, and only reads PDF imports', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(1))
    await mockFetch((b) => answer(b))
    await expect(assistPdf(db, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'import.expired' })
    setSecret(db, 'aiKey.mistral', null)
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject({ code: 'assistant.no_key' })
    updateSettings(db, { aiProvider: 'anthropic' })
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject({ code: 'assistant.no_key' })
    expect(requests).toHaveLength(0)
  })

  it('asks the model for JSON without tools, and tells it the text is data', async () => {
    const { assistPdf, PDF_INSTRUCTIONS } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = setup(statement(1))
    await mockFetch((b) => answer(b))
    await assistPdf(db, sessionId)
    const body = requests[0] as unknown as Record<string, unknown> & Body
    expect(body['tools']).toBeUndefined()
    expect((body['response_format'] as { type: string }).type).toBe('json_schema')
    expect(body.messages[0]!.content).toContain(PDF_INSTRUCTIONS)
    expect(PDF_INSTRUCTIONS).toMatch(/never instructions/)
    expect(PDF_INSTRUCTIONS).toMatch(/copy the characters exactly/)
  })
})

describe('saving a PDF import', () => {
  it('recognises an import read from a PDF, which always waits for the person', async () => {
    const { isPdfCommit } = await import('../src/main/assistant/tools')
    const pdf = setup(statement(1))
    expect(isPdfCommit('import.commit', { sessionId: pdf.sessionId })).toBe(true)
    expect(isPdfCommit('import.commit', {})).toBe(true)
    expect(isPdfCommit('budgets.set', { sessionId: pdf.sessionId })).toBe(false)
    // A CSV import is not affected, and an import that is gone is not a PDF one.
    const sessionId = analyze(pdf.db, { fileName: 'x.csv', bytes: new TextEncoder().encode('Date;Amount\n2026-11-01;-1,00'), accountId: pdf.accountId }).sessionId
    expect(isPdfCommit('import.commit', { sessionId })).toBe(false)
    expect(isPdfCommit('import.commit', { sessionId: '00000000-0000-4000-8000-000000000000' })).toBe(false)
  })

  it('tells the person where the rows come from and when the totals do not add up', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { describeChange } = await import('../src/main/assistant/tools')
    // The statement says the balance went from 0,00 to 10,00; the four rows make −0,50.
    const { db, sessionId } = setup(statement(2), { opening: 0, closing: 1000 })
    await mockFetch((b) => answer(b))
    await assistPdf(db, sessionId)
    const text = describeChange(db, 'import.commit', { sessionId })
    expect(text).toMatch(/^Import 4 rows from the PDF statement \(read by the assistant from the statement’s text\) \(/)
    expect(text).toMatch(/Warning: the rows don’t add up to the statement’s closing balance \(difference [^)]*10[.,]50[^)]*\)/)
    const ok = setup(statement(2), { opening: 0, closing: -50 })
    await assistPdf(ok.db, ok.sessionId)
    expect(describeChange(ok.db, 'import.commit', { sessionId: ok.sessionId })).not.toMatch(/Warning/)
  })
})
