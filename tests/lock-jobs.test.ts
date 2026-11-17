import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { analyzeGrid, preview as importPreview } from '@core/import'
import { insertTransaction } from '@core/finance'
import type { PdfLine } from '@core/pdf/lines'
import { setSecret } from '@core/secrets'
import { updateSettings } from '@core/settings'
import { createReadSlot } from '../src/main/pdf/handle'

const sent: { type: string; sessionId?: string; error?: { code: string } | null }[] = []
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_c: string, e: (typeof sent)[number]) => sent.push(e) } }] },
  powerMonitor: { on: vi.fn() }
}))

// All data here is invented.
const OWN = 'BE68539007547034'

const line = (id: number, page: number, cells: [number, string][]): PdfLine => ({ id, page, y: 800 - id * 12, pageHeight: 842, cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 })) })
const STATEMENT: PdfLine[] = [
  line(0, 1, [[60, 'Date'], [140, 'Description'], [400, 'Amount'], [510, 'Balance']]),
  line(1, 1, [[60, '01/11'], [140, 'SHOP 1'], [400, '1,50-'], [510, '100,00']])
]

function setupDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-lock-')), 'k.db'), randomBytes(32).toString('hex'))
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm' })
  return db
}

function setupPdf(): { db: Db; sessionId: string } {
  const db = setupDb()
  const accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  const preview = analyzeGrid(db, {
    fileName: 'statement.pdf',
    accountId,
    grid: [],
    pdf: { lines: STATEMENT, pages: 1, readBy: 'kasboek', balances: { opening: null, closing: null }, period: { from: '2026-11-01', to: '2026-11-30' }, notes: [{ code: 'no_table', pages: 1, lines: STATEMENT.length }] }
  })
  return { db, sessionId: preview.sessionId }
}

type Handler = (n: number, signal: AbortSignal) => Promise<Response>
async function mockFetch(handler: Handler): Promise<{ count: () => number }> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  let n = 0
  fetch.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => handler(++n, init.signal))
  return { count: () => n }
}
/** A request that stays open until it is stopped. */
const hang: Handler = (_n, signal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
const answerRows = (): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ rows: [{ lines: [1], date: '01/11', valueDate: null, amount: '1,50-', direction: null, balance: '100,00', counterparty: 'SHOP 1' }], openingBalance: null, closingBalance: null, notes: [] }) } }] }), { status: 200 })
const code = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: { code?: string }) => e.code)

describe('the app locking while the assistant works', () => {
  it('stops every running job, and nothing is written afterwards', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { cancelAllAssists, assistStatus } = await import('../src/main/assistant/jobs')
    const { db, sessionId } = setupPdf()
    const fetch = await mockFetch(hang)
    const run = assistPdf(db, sessionId)
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    cancelAllAssists()
    expect(await code(run)).toBe('assistant.cancelled')
    expect(assistStatus(sessionId)).toMatchObject({ running: false })
    expect(importPreview(db, sessionId).pdf).toMatchObject({ readBy: 'kasboek' })
  })

  it('stops a tips run, and no tips are saved', async () => {
    const { runInsights, cancelInsights, insightsStatus } = await import('../src/main/assistant/insights')
    const db = setupDb()
    const account = Number(db.prepare("INSERT INTO accounts (name, kind, currency, iban) VALUES ('Joint account', 'current', 'EUR', ?)").run(OWN).lastInsertRowid)
    for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) insertTransaction(db, { accountId: account, bookingDate: `${m}-12`, amountCents: m === '2026-10' ? -2500 : -2000, description: `Gym Club ${m}`, counterpartyName: 'Gym Club' })
    const fetch = await mockFetch(hang)
    const run = runInsights(db, '2026-11', { consent: true, today: '2026-11-10' })
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    cancelInsights()
    expect(await code(run)).toBe('insights.cancelled')
    expect(insightsStatus().running).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 })
  })

  it('stops the PDF read in progress', () => {
    const slot = createReadSlot()
    const controller = slot.claim()!
    slot.abort()
    expect(controller.signal.aborted).toBe(true)
  })
})

describe('restarting a job for the same import', () => {
  it('lets the stopped job end without telling the screen, so the new job stays shown as running', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { assistStatus } = await import('../src/main/assistant/jobs')
    const { db, sessionId } = setupPdf()
    let release: () => void = () => undefined
    const second = new Promise<void>((resolve) => (release = resolve))
    const fetch = await mockFetch((n, signal) => (n === 1 ? hang(n, signal) : second.then(answerRows)))
    sent.length = 0
    const first = assistPdf(db, sessionId)
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    const again = assistPdf(db, sessionId)
    expect(await code(first)).toBe('assistant.cancelled')
    await vi.waitFor(() => expect(fetch.count()).toBe(2))
    expect(sent.filter((e) => e.type === 'import.checkDone')).toEqual([])
    expect(assistStatus(sessionId)).toMatchObject({ running: true })
    release()
    await again
    expect(sent.filter((e) => e.type === 'import.checkDone')).toEqual([{ type: 'import.checkDone', sessionId, error: null }])
    expect(assistStatus(sessionId)).toMatchObject({ running: false, error: null })
  })
})

describe('the cancel handle of the PDF read', () => {
  it('refuses a second read without touching the first, and only the owner frees it', () => {
    const slot = createReadSlot()
    const first = slot.claim()!
    expect(slot.claim()).toBeNull()
    // The refused call has nothing to release; even a stray release of another controller changes nothing.
    slot.release(new AbortController())
    slot.abort()
    expect(first.signal.aborted).toBe(true)
    slot.release(first)
    expect(slot.claim()).not.toBeNull()
  })
})
