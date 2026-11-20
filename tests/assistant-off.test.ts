import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { insertTransaction } from '@core/finance'
import { analyzeGrid } from '@core/import'
import type { PdfLine } from '@core/pdf/lines'
import { setSecret } from '@core/secrets'
import { DEFAULT_SETTINGS, getSettings, requireAssistant, resetImportedSettings, updateSettings } from '@core/settings'
import { contract } from '@shared/contract'
import { addMonths, localToday } from '@shared/month'
import { ASSISTANT_OPS, assistantRefusal } from '../src/main/assistant-guard'
import { assistantTools, compactResult, mcpTools, opForTool } from '../src/main/assistant/tools'

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

function openDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-off-')), 'k.db'), randomBytes(32).toString('hex'))
  // A provider that is fully set up: only the switch stands between the app and the network.
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm' })
  state.db = db
  return db
}

/** A PDF import that is open and could be read by the assistant. */
function pdfSession(db: Db): string {
  const accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  return analyzeGrid(db, {
    fileName: 'statement.pdf',
    accountId,
    grid: [],
    pdf: { lines: STATEMENT, pages: 1, readBy: 'kasboek', balances: { opening: null, closing: null }, period: { from: '2026-11-01', to: '2026-11-30' }, notes: [{ code: 'no_table', pages: 1, lines: STATEMENT.length }] }
  }).sessionId
}

/** Month facts for the tips: a payment that grew over the last months. */
function tipsData(db: Db): string {
  const account = Number(db.prepare("INSERT INTO accounts (name, kind, currency, iban) VALUES ('Joint account', 'current', 'EUR', NULL)").run().lastInsertRowid)
  const month = localToday().slice(0, 7)
  ;[4, 3, 2, 1].forEach((n) => {
    const m = addMonths(month, -n)
    insertTransaction(db, { accountId: account, bookingDate: `${m}-12`, amountCents: n === 1 ? -2500 : -2000, description: `Gym Club ${m}`, counterpartyName: 'Gym Club' })
  })
  return month
}

/** Every request to a provider goes through net.fetch; this counts them, and keeps each one open until it is stopped. */
async function hangingFetch(): Promise<{ count: () => number }> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  fetch.mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  )
  return { count: () => fetch.mock.calls.length }
}

afterEach(() => vi.restoreAllMocks())

describe('the setting', () => {
  it('is on by default and stored like the other settings', () => {
    const db = openDb()
    expect(DEFAULT_SETTINGS.assistantEnabled).toBe(true)
    expect(getSettings(db).assistantEnabled).toBe(true)
    updateSettings(db, { assistantEnabled: false })
    expect(getSettings(db).assistantEnabled).toBe(false)
    expect(() => requireAssistant(db)).toThrowError(expect.objectContaining({ code: 'assistant.disabled' }))
    updateSettings(db, { assistantEnabled: true })
    expect(() => requireAssistant(db)).not.toThrow()
  })

  it('is changed by the person through settings.update', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const db = openDb()
    expect(await dispatch('settings.update', { assistantEnabled: false }, 'user')).toMatchObject({ ok: true, data: { assistantEnabled: false } })
    expect(getSettings(db).assistantEnabled).toBe(false)
    expect(await dispatch('settings.update', { assistantEnabled: true }, 'user')).toMatchObject({ ok: true, data: { assistantEnabled: true } })
  })
})

describe('an import never switches the assistant on', () => {
  it('keeps it off when the file says off', () => {
    const d = openDb()
    updateSettings(d, { assistantEnabled: false })
    resetImportedSettings(d)
    expect(getSettings(d).assistantEnabled).toBe(false)
  })

  it('turns it off when it is off on this computer, whatever the file says', () => {
    const d = openDb()
    // The provider and key that openDb sets are reset as always; the switch is not among what is reported.
    expect(resetImportedSettings(d, { assistantOff: true })).toEqual(['aiKey', 'aiEndpoint'])
    expect(getSettings(d).assistantEnabled).toBe(false)
    updateSettings(d, { assistantEnabled: true })
    resetImportedSettings(d, { assistantOff: true })
    expect(getSettings(d).assistantEnabled).toBe(false)
  })

  it('leaves a file without the setting alone, so the default (on) of a new database applies', () => {
    const d = openDb()
    resetImportedSettings(d)
    expect(d.prepare("SELECT 1 FROM settings WHERE key = 'assistantEnabled'").get()).toBeUndefined()
    expect(getSettings(d).assistantEnabled).toBe(true)
  })

  it('is not reported as something that was reset: nothing has to be set up again', () => {
    const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-off-')), 'k.db'), randomBytes(32).toString('hex'))
    updateSettings(d, { assistantEnabled: false })
    expect(resetImportedSettings(d, { assistantOff: true })).toEqual([])
    expect(getSettings(d).assistantEnabled).toBe(false)
  })
})

describe('the main process refuses while the assistant is off', () => {
  it('refuses every operation of the assistant family with assistant.disabled, and no request is made', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const db = openDb()
    updateSettings(db, { assistantEnabled: false })
    const fetch = await hangingFetch()
    const sessionId = pdfSession(db)
    const inputs: Record<string, unknown> = { 'import.assist': { sessionId }, 'import.pdfAssist': { sessionId, consent: true }, 'insights.run': { month: '2026-11', consent: true } }
    for (const op of ASSISTANT_OPS) {
      for (const actor of ['user', 'assistant'] as const) {
        const result = await dispatch(op, inputs[op] ?? {}, actor)
        expect(result, `${op} as ${actor}`).toMatchObject({ ok: false, error: { code: 'assistant.disabled' } })
      }
    }
    expect(fetch.count()).toBe(0)
  })

  it('covers each family: chat, models, memory, CSV and PDF checks, tips and the month review', () => {
    const families = ['assistant.send', 'assistant.stop', 'assistant.reset', 'assistant.status', 'assistant.models', 'assistant.setKey', 'memory.list', 'memory.remember', 'memory.add', 'import.assist', 'import.assistPreview', 'import.assistStatus', 'import.pdfAssist', 'import.pdfAssistPreview', 'insights.run', 'insights.preview']
    for (const op of families) expect(ASSISTANT_OPS).toContain(op)
    // Every operation named assistant.* is on the list, also one added later.
    for (const op of Object.keys(contract).filter((k) => k.startsWith('assistant.') || k.startsWith('memory.'))) expect(ASSISTANT_OPS).toContain(op)
  })

  it('refuses the month review for the app’s own pages but not for the Claude apps (MCP), which are separate', () => {
    expect(assistantRefusal('summary.review', 'user', {}, false)).toMatchObject({ error: { code: 'assistant.disabled' } })
    expect(assistantRefusal('summary.review', 'assistant', {}, false)).toBeNull()
    expect(assistantRefusal('summary.review', 'user', {}, true)).toBeNull()
  })

  it('leaves the switch of the Claude apps reachable, and nothing else of assistant.configure', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const db = openDb()
    updateSettings(db, { assistantEnabled: false })
    expect(await dispatch('assistant.configure', { mcpEnabled: true }, 'user')).toMatchObject({ ok: true, data: { mcpEnabled: true } })
    for (const patch of [{ aiProvider: 'anthropic' }, { permissions: { mode: 'ask', rules: {}, mcpAlwaysAsk: true } }, { mcpEnabled: true, pageContextEnabled: true }, {}]) {
      expect(await dispatch('assistant.configure', patch, 'user'), JSON.stringify(patch)).toMatchObject({ ok: false, error: { code: 'assistant.disabled' } })
    }
    expect(getSettings(db).aiProvider).toBe('mistral')
  })

  it('does not touch the operations of the app itself, nor the tool list of the Claude apps', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const db = openDb()
    updateSettings(db, { assistantEnabled: false })
    expect(await dispatch('settings.get', {}, 'user')).toMatchObject({ ok: true })
    expect(await dispatch('insights.get', { month: '2026-11' }, 'user')).toMatchObject({ ok: true })
    expect(await dispatch('import.batches', {}, 'user')).toMatchObject({ ok: true })
    expect(await dispatch('summary.review', { month: '2026-10' }, 'assistant')).toMatchObject({ ok: true })
    // No tool of the Claude apps is one that is refused for being the assistant's: MCP keeps its own switch only.
    expect(mcpTools().filter((t) => ASSISTANT_OPS.includes(t.op))).toEqual([])
    expect(mcpTools().map((t) => t.name)).toContain('summary_review')
  })

  it('also stops the modules themselves: no provider is asked even when called directly', async () => {
    const db = openDb()
    const sessionId = pdfSession(db)
    const month = tipsData(db)
    updateSettings(db, { assistantEnabled: false })
    const fetch = await hangingFetch()
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { runInsights, insightsPreview } = await import('../src/main/assistant/insights')
    const { listProviderModels, checkProviderKey } = await import('../src/main/assistant/models')
    const { activeProvider } = await import('../src/main/assistant/provider')
    const { client } = await import('../src/main/assistant/claude')
    const { send } = await import('../src/main/assistant/chat')
    const refused = { code: 'assistant.disabled' }
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject(refused)
    await expect(runInsights(db, month, { consent: true })).rejects.toMatchObject(refused)
    expect(() => insightsPreview(db, month)).toThrowError(expect.objectContaining(refused))
    await expect(listProviderModels(db)).rejects.toMatchObject(refused)
    expect(() => client(db)).toThrowError(expect.objectContaining(refused))
    expect(() => send('hello')).toThrowError(expect.objectContaining(refused))
    // Checking a key is refused one step earlier, by the operation (assistant.setKey); the helper only receives a provider.
    expect(() => activeProvider(db)).toThrowError(expect.objectContaining(refused))
    expect(checkProviderKey).toBeTypeOf('function')
    expect(fetch.count()).toBe(0)
  })
})

describe('switching the assistant off while it works', () => {
  it('cancels a running import job and a tips run, and nothing is sent afterwards', async () => {
    const { dispatch } = await import('../src/main/ipc')
    const db = openDb()
    const sessionId = pdfSession(db)
    const month = tipsData(db)
    const fetch = await hangingFetch()

    const job = dispatch('import.pdfAssist', { sessionId, consent: true }, 'user')
    await vi.waitFor(() => expect(fetch.count()).toBe(1))
    const tips = dispatch('insights.run', { month, consent: true }, 'user')
    await vi.waitFor(() => expect(fetch.count()).toBe(2))

    expect(await dispatch('settings.update', { assistantEnabled: false }, 'user')).toMatchObject({ ok: true })
    expect(await job).toMatchObject({ ok: false, error: { code: 'assistant.cancelled' } })
    expect(await tips).toMatchObject({ ok: false, error: { code: 'insights.cancelled' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 })
    expect(await dispatch('import.pdfAssist', { sessionId, consent: true }, 'user')).toMatchObject({ ok: false, error: { code: 'assistant.disabled' } })
    expect(fetch.count()).toBe(2)
  })

  it('clears the conversation, like locking does', async () => {
    const { dispatch } = await import('../src/main/ipc')
    openDb()
    // The chat module loads the first time it is used.
    expect(await dispatch('assistant.status', {}, 'user')).toMatchObject({ ok: true })
    const chat = await import('../src/main/assistant/chat')
    const reset = vi.spyOn(chat, 'resetChat')
    await dispatch('settings.update', { assistantEnabled: false }, 'user')
    expect(reset).toHaveBeenCalledTimes(1)
    // Other changes do not clear it.
    await dispatch('settings.update', { assistantEnabled: true, currency: 'USD' }, 'user')
    expect(reset).toHaveBeenCalledTimes(1)
  })
})

describe('what the assistant itself can see and change', () => {
  it('cannot change the switch: no tool of the chat or the Claude apps takes it, and settings.update is not a tool', () => {
    expect(opForTool('settings_update')).toBeUndefined()
    expect(mcpTools().some((t) => t.op === 'settings.update')).toBe(false)
    for (const tool of assistantTools()) {
      const entry = contract[tool.op] as { input: { safeParse: (v: unknown) => { success: boolean } } }
      expect(entry.input.safeParse({ assistantEnabled: false }).success, tool.name).toBe(false)
    }
  })

  it('does not see the switch or any other setting of the assistant in settings.get', () => {
    const db = openDb()
    updateSettings(db, { assistantEnabled: false, mcpEnabled: true })
    const seen = JSON.parse(compactResult('settings.get', getSettings(db))) as Record<string, unknown>
    for (const key of ['assistantEnabled', 'aiProvider', 'aiProviders', 'aiBaseUrl', 'aiChatModel', 'aiCsvModel', 'aiPdfModel', 'aiReasoning', 'aiCsvReasoning', 'chatModel', 'chatEffort', 'csvModel', 'csvEffort', 'permissions', 'memoryEnabled', 'pageContextEnabled', 'mcpEnabled', 'aiInsightsConsent', 'aiCheckConsent']) {
      expect(seen, key).not.toHaveProperty(key)
    }
    expect(seen).toHaveProperty('currency')
  })
})
