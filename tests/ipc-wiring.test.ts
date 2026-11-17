import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { analyzeGrid } from '@core/import'
import type { PdfLine } from '@core/pdf/lines'
import { setSecret } from '@core/secrets'
import { updateSettings } from '@core/settings'

// All data here is invented.
const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => '', getName: () => 'Kasboek', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => undefined },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../src/main/session', () => ({
  db: () => state.db,
  isUnlocked: () => true,
  whenSessionReady: () => Promise.resolve(),
  broadcast: vi.fn(),
  onLock: vi.fn(),
  status: vi.fn()
}))

const OWN = 'BE68539007547034'
const line = (id: number, page: number, cells: [number, string][]): PdfLine => ({ id, page, y: 800 - id * 12, pageHeight: 842, cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 })) })
const STATEMENT: PdfLine[] = [
  line(0, 1, [[60, 'Date'], [140, 'Description'], [400, 'Amount'], [510, 'Balance']]),
  line(1, 1, [[60, '01/11'], [140, 'SHOP 1'], [400, '1,50-'], [510, '100,00']])
]

function setupPdf(): string {
  const db: Db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-ipc-')), 'k.db'), randomBytes(32).toString('hex'))
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm' })
  state.db = db
  const accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  return analyzeGrid(db, {
    fileName: 'statement.pdf',
    accountId,
    grid: [],
    pdf: { lines: STATEMENT, pages: 1, readBy: 'kasboek', balances: { opening: null, closing: null }, period: { from: '2026-11-01', to: '2026-11-30' }, notes: [{ code: 'no_table', pages: 1, lines: STATEMENT.length }] }
  }).sessionId
}

/** A model request that stays open until it is stopped. */
async function hangingFetch(): Promise<{ count: () => number }> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  let n = 0
  fetch.mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        n++
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
  )
  return { count: () => n }
}

describe('stopping an assistant job through the operations', () => {
  it('Stop (import.assistCancel) ends a running job, and import.assistStatus shows it', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const sessionId = setupPdf()
    const fetch = await hangingFetch()
    const run = dispatch('import.pdfAssist', { sessionId, consent: true }, 'user')
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    expect(await dispatch('import.assistStatus', { sessionId }, 'user')).toMatchObject({ ok: true, data: { running: true, kind: 'pdf' } })
    expect(await dispatch('import.assistCancel', { sessionId }, 'user')).toEqual({ ok: true, data: { ok: true } })
    expect(await run).toMatchObject({ ok: false, error: { code: 'assistant.cancelled' } })
    expect(await dispatch('import.assistStatus', { sessionId }, 'user')).toMatchObject({ ok: true, data: { running: false } })
  })

  it('the app locking (cancelRunningJobs) ends a running job', async () => {
    const { dispatch, cancelRunningJobs } = await import('../src/main/ipc')
    const sessionId = setupPdf()
    const fetch = await hangingFetch()
    const run = dispatch('import.pdfAssist', { sessionId, consent: true }, 'user')
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    cancelRunningJobs()
    expect(await run).toMatchObject({ ok: false, error: { code: 'assistant.cancelled' } })
  })

  it('reading a PDF with the assistant needs the consent from the dialog', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const sessionId = setupPdf()
    const fetch = await hangingFetch()
    for (const input of [{ sessionId }, { sessionId, consent: false }]) {
      expect(await dispatch('import.pdfAssist', input, 'user')).toMatchObject({ ok: false, error: { code: 'op.invalid_input' } })
    }
    expect(fetch.count()).toBe(0)
  })
})

describe('lazy modules in ipc.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/ipc.ts'), 'utf8')
  const names = [...source.matchAll(/^const (\w+) = lazy\(/gm)].map((m) => m[1]!)

  it('finds the lazy modules', () => {
    expect(names).toEqual(expect.arrayContaining(['chat', 'insights', 'syncService']))
  })

  // A module that is only ever read with loaded() would never load, so what it stops could never run.
  it.each(names)('%s: when it is read with loaded(), something loads it with get()', (name) => {
    if (new RegExp(`\\b${name}\\.loaded\\(\\)`).test(source)) expect(source).toMatch(new RegExp(`\\b${name}\\.get\\(\\)`))
  })
})
