import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { insertTransaction } from '@core/finance'
import { INSIGHTS_CONSENT_VERSION } from '@core/insight-plan'
import { giveFeedback, insightsView } from '@core/insights'
import { setSecret } from '@core/secrets'
import { DEFAULT_SETTINGS, getSettings, resetImportedSettings, updateSettings } from '@core/settings'
import { CLAUDE_PDF_MODEL, resolveProvider } from '@shared/ai-provider-store'
import { renderInsightText } from '@shared/insights'

const sent: { type: string; month?: string }[] = []
const prefs = vi.hoisted(() => ({ language: 'en' }))
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_c: string, e: (typeof sent)[number]) => sent.push(e) } }] },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../src/main/prefs', async (original) => ({ ...(await original<typeof import('../src/main/prefs')>()), getPrefs: () => ({ language: prefs.language }) }))

// All data here is invented.
const TODAY = '2026-11-10'
const MONTH = '2026-11'
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10']

type Body = { model: string; reasoning_effort?: string; messages: { role: string; content: string }[] }
const requests: Body[] = []
const userText = (b: Body): string => b.messages.find((m) => m.role === 'user')!.content
const reply = (content: string, finish = 'stop'): Response => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })

async function mockFetch(handler: (body: Body, n: number, signal: AbortSignal) => Response | Promise<Response>): Promise<void> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  requests.length = 0
  fetch.mockImplementation(async (_url: string, init: { body: string; signal: AbortSignal }) => {
    const body = JSON.parse(init.body) as Body
    requests.push(body)
    return handler(body, requests.length, init.signal)
  })
}

/** The fact id a kind got in what was sent. */
const idOf = (b: Body, kind: string): string => new RegExp(`^(f\\d+) ${kind} `, 'm').exec(userText(b))![1]!
/** An answer with one tip for the price rise. */
const tip = (b: Body, extra: Record<string, unknown> = {}): Response => {
  const f = idOf(b, 'price_up')
  return reply(JSON.stringify({ suggestions: [{ facts: [f], severity: 'tip', title: `{${f}.name} got dearer`, body: `Now {${f}.to}, before {${f}.from}.`, ...extra }] }))
}

function setup(): { db: Db; pay: (date: string, cents: number, name: string) => void } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-ai-')), 'k.db'), randomBytes(32).toString('hex'))
  // Nothing here needs to survive a crash; skipping the disk flush per statement keeps slow disks (Windows CI) fast.
  db.pragma('synchronous = OFF')
  const account = Number(db.prepare("INSERT INTO accounts (name, kind, currency, iban) VALUES ('Joint account', 'current', 'EUR', 'BE68539007547034')").run().lastInsertRowid)
  const pay = (date: string, cents: number, name: string): void => void insertTransaction(db, { accountId: account, bookingDate: date, amountCents: cents, description: `${name} ${date}`, counterpartyName: name })
  for (const m of MONTHS.slice(0, 3)) pay(`${m}-05`, -1200, 'Streamly')
  pay('2026-10-05', -1500, 'Streamly')
  for (const m of MONTHS) pay(`${m}-12`, -2000, 'Gym Club')
  for (const m of MONTHS) pay(`${m}-01`, -90000, 'Landlord BE68 5390 0754 7034')
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'chat-m', aiCsvModel: 'file-m' })
  return { db, pay }
}

const row = (db: Db) => db.prepare('SELECT * FROM insights WHERE month = ?').get(MONTH) as Record<string, string> | undefined
const code = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: { code?: string }) => e.code)

beforeEach(async () => {
  sent.length = 0
  prefs.language = 'en'
  const { cancelInsights } = await import('../src/main/assistant/insights')
  cancelInsights()
})

describe('consent', () => {
  it('is needed before anything is sent', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch(() => reply('{}'))
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(0)
    expect(getSettings(db).aiInsightsConsent).toBeNull()
    expect(row(db)).toBeUndefined()
  })

  it('is stored per provider and version when given, and not asked again', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(getSettings(db).aiInsightsConsent).toMatchObject({ provider: 'mistral', version: INSIGHTS_CONSENT_VERSION })
    expect(Date.parse(getSettings(db).aiInsightsConsent!.at)).not.toBeNaN()
    await runInsights(db, MONTH, { today: TODAY })
    expect(requests).toHaveLength(2)
  })

  it('is asked again when the list of data that is sent changes (a newer version)', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    updateSettings(db, { aiInsightsConsent: { provider: 'mistral', version: INSIGHTS_CONSENT_VERSION - 1, at: '2026-01-01T00:00:00.000Z' } })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(0)
  })

  it('is asked again after switching to another provider, also a custom one', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    setSecret(db, 'aiKey.groq', 'other-key')
    updateSettings(db, { aiProvider: 'groq', aiChatModel: 'g' })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(1)
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(getSettings(db).aiInsightsConsent?.provider).toBe('groq')
    updateSettings(db, { aiProvider: 'custom-abc123', aiBaseUrl: 'http://localhost:8080/v1', aiChatModel: 'local' })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
  })

  it('is asked again when the address of the provider changes, but not for the same address written a little differently', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    updateSettings(db, { aiProvider: 'custom-abc123', aiBaseUrl: 'http://localhost:8080/v1', aiChatModel: 'local' })
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(getSettings(db).aiInsightsConsent).toMatchObject({ provider: 'custom-abc123', baseUrl: 'http://localhost:8080/v1', model: 'file-m' })
    await runInsights(db, MONTH, { today: TODAY })
    updateSettings(db, { aiBaseUrl: 'HTTP://localhost:8080/v1/' })
    await runInsights(db, MONTH, { today: TODAY })
    expect(requests).toHaveLength(3)
    updateSettings(db, { aiBaseUrl: 'http://192.168.1.20:8080/v1' })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(3)
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(getSettings(db).aiInsightsConsent?.baseUrl).toBe('http://192.168.1.20:8080/v1')
  })

  it('is asked again when the model that reads the summary changes', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    updateSettings(db, { aiCsvModel: 'another-model' })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(1)
  })

  it('treats a record from before the address and model were kept as not agreed, and does not crash on it', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    updateSettings(db, { aiInsightsConsent: { provider: 'mistral', version: INSIGHTS_CONSENT_VERSION, at: '2026-01-01T00:00:00.000Z' } })
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.consent_needed')
    expect(requests).toHaveLength(0)
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(getSettings(db).aiInsightsConsent).toMatchObject({ provider: 'mistral', model: 'file-m' })
    expect(typeof getSettings(db).aiInsightsConsent?.baseUrl).toBe('string')
  })

  it('is cleared by the reset after an import', () => {
    const { db } = setup()
    db.prepare("INSERT INTO insights (month, created_at, provider, model, language, facts_hash, facts_json, suggestions_json) VALUES ('2026-11', 'x', 'mistral', 'm', 'en', 'h', '[]', '[]')").run()
    updateSettings(db, { aiInsightsConsent: { provider: 'mistral', version: INSIGHTS_CONSENT_VERSION, at: '2026-01-01T00:00:00.000Z' } })
    resetImportedSettings(db)
    expect(getSettings(db).aiInsightsConsent).toBeNull()
    expect(DEFAULT_SETTINGS.aiInsightsConsent).toBeNull()
    expect(row(db)).toBeUndefined()
  })
})

describe('writing tips', () => {
  it('sends exactly the preview, nothing private, to the model for reading files, and keeps the checked tips', async () => {
    const { runInsights, insightsPreview } = await import('../src/main/assistant/insights')
    const { db } = setup()
    const preview = insightsPreview(db, MONTH, TODAY)
    await mockFetch((b) => tip(b))
    const view = await runInsights(db, MONTH, { consent: true, today: TODAY })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.model).toBe('file-m')
    expect(userText(requests[0]!)).toBe(preview.text)
    expect(preview).toMatchObject({ facts: 3, providerName: 'Mistral', company: 'Mistral AI' })
    expect(preview.approxTokens).toBeGreaterThan(preview.text.length / 4)
    const everything = JSON.stringify(requests)
    for (const secret of ['BE68539007547034', '5390 0754', 'Joint account', '90000', 'transactionIds', 'recurringKey', 'out:streamly']) expect(everything).not.toContain(secret)
    expect(userText(requests[0]!)).toContain('names: Landlord BE…7034, Gym Club, Streamly')
    expect(userText(requests[0]!)).toContain('name: Streamly | from≈12 EUR | to≈15 EUR | change≈3 EUR | date: 2026-10-05')
    expect(requests[0]!.messages.find((m) => m.role === 'system')!.content.endsWith('Write in English.')).toBe(true)

    expect(view.ai).toMatchObject({ providerName: 'Mistral', model: 'file-m', language: 'en', stale: null })
    expect(view.ai!.suggestions).toEqual([{ kind: 'price_up', severity: 'tip', factKeys: [expect.stringMatching(/^price_up:out:streamly/)], title: expect.stringContaining('{f'), body: expect.stringContaining('{f') }])
    // Numbers are filled in from the facts at display time, in the format asked for.
    const [s] = view.ai!.suggestions
    expect(renderInsightText(s!.body, view.ai!.facts, (c, cur) => `${cur} ${c / 100}`, (iso) => iso)).toBe('Now EUR 15, before EUR 12.')
    expect(row(db)).toMatchObject({ month: MONTH, provider: 'mistral', model: 'file-m', language: 'en' })
    expect(sent).toContainEqual({ type: 'insights.updated', month: MONTH })
  })

  it('does not send anything when no assistant is set up', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    updateSettings(db, { aiProvider: 'anthropic' })
    await mockFetch(() => reply('{}'))
    expect(await code(runInsights(db, MONTH, { consent: true, today: TODAY }))).toBe('assistant.no_key')
    expect(requests).toHaveLength(0)
  })

  it('asks no one and sends nothing when there are no facts', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch(() => reply('{}'))
    const view = await runInsights(db, '2024-01', { today: TODAY })
    expect(view).toEqual({ facts: [], ai: null })
    expect(requests).toHaveLength(0)
  })

  it('retries a cut-off answer once with less reasoning', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    updateSettings(db, { aiCsvReasoning: 'high' })
    await mockFetch((b, n) => (n === 1 ? reply('{"suggestions":[{"facts":["f1"', 'length') : tip(b)))
    const view = await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(requests.map((b) => b.reasoning_effort)).toEqual(['high', 'medium'])
    expect(view.ai!.suggestions).toHaveLength(1)
    // Cut off twice: a readable error, no more calls, nothing stored.
    await mockFetch(() => reply('', 'length'))
    db.prepare('DELETE FROM insights').run()
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.too_long')
    expect(requests).toHaveLength(2)
    expect(row(db)).toBeUndefined()
  })

  it('throws insights.unchecked and keeps the old tips when nothing the assistant wrote checks out', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    const before = row(db)
    await mockFetch((b) => tip(b, { body: 'Now 15 euro.' }))
    expect(await code(runInsights(db, MONTH, { today: TODAY }))).toBe('insights.unchecked')
    expect(row(db)).toEqual(before)
  })

  it('stops at once with Stop, and a new run can start after', async () => {
    const { runInsights, cancelInsights, insightsStatus } = await import('../src/main/assistant/insights')
    const { db } = setup()
    expect(insightsStatus()).toEqual({ running: false, month: null, startedAt: null })
    await mockFetch((_b, _n, signal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    const run = runInsights(db, MONTH, { consent: true, today: TODAY })
    // The status tells a card that was left and opened again which run is going on.
    expect(insightsStatus()).toEqual({ running: true, month: MONTH, startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
    const second = runInsights(db, MONTH, { today: TODAY })
    expect(await code(second)).toBe('insights.busy')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    sent.length = 0
    expect(cancelInsights()).toEqual({ ok: true })
    expect(await code(run)).toBe('insights.cancelled')
    expect(insightsStatus().running).toBe(false)
    // Whatever way a run ends, the card is told, so it stops showing it as running.
    expect(sent).toContainEqual({ type: 'insights.updated', month: MONTH })
    expect(row(db)).toBeUndefined()
    await mockFetch((b) => tip(b))
    expect((await runInsights(db, MONTH, { today: TODAY })).ai).not.toBeNull()
  })

  it('does nothing when Stop is pressed and nothing runs', async () => {
    const { cancelInsights } = await import('../src/main/assistant/insights')
    expect(cancelInsights()).toEqual({ ok: true })
    expect(cancelInsights()).toEqual({ ok: true })
  })

  it('keeps the old tips and gives a readable error when the provider can not be reached', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    const before = row(db)
    await mockFetch(() => Promise.reject(new TypeError('fetch failed')))
    // The client retries a network error after 1 s and 3 s; fake timers skip those waits.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = runInsights(db, MONTH, { today: TODAY }).catch((e: unknown) => e as { code: string; message: string })
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await run.finally(() => vi.useRealTimers())
    expect(err).toMatchObject({ code: 'assistant.failed', details: { kind: 'network', status: 0 } })
    expect(row(db)).toEqual(before)
    expect(insightsView(db, MONTH, 'en', TODAY).ai!.suggestions).toHaveLength(1)
  })
})

describe('showing the kept tips', () => {
  it('marks them stale when the data changed, or the interface language did', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db, pay } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    expect(insightsView(db, MONTH, 'en', TODAY).ai!.stale).toBeNull()
    expect(insightsView(db, MONTH, 'nl', TODAY).ai!.stale).toBe('language')
    // The same view where the language is not known: only the data counts.
    expect(insightsView(db, MONTH, null, TODAY).ai!.stale).toBeNull()
    pay('2026-11-03', -45000, 'Corner Shop')
    // A large first payment shows up as a new fact.
    const later = insightsView(db, MONTH, 'en', TODAY)
    expect(later.facts.length).toBeGreaterThan(2)
    expect(later.ai!.stale).toBe('data')
    expect(later.ai!.suggestions).toHaveLength(1)
  })

  it('leaves out what the person hid since, without calling that a change in the data', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    const view = await runInsights(db, MONTH, { consent: true, today: TODAY })
    const key = view.ai!.suggestions[0]!.factKeys[0]!
    giveFeedback(db, key, 'dismissed')
    const after = insightsView(db, MONTH, 'en', TODAY)
    expect(after.facts.map((f) => f.key)).not.toContain(key)
    expect(after.ai!.suggestions).toEqual([])
    expect(after.ai!.stale).toBeNull()
    // And a later run does not send it.
    await mockFetch(() => reply('{"suggestions":[]}'))
    await runInsights(db, MONTH, { today: TODAY })
    expect(userText(requests[0]!)).not.toContain('price_up')
  })

  it('shows tips written for the language that was in use, and a refresh in the new one', async () => {
    const { runInsights } = await import('../src/main/assistant/insights')
    const { db } = setup()
    await mockFetch((b) => tip(b))
    await runInsights(db, MONTH, { consent: true, today: TODAY })
    prefs.language = 'nl'
    const view = await runInsights(db, MONTH, { today: TODAY })
    expect(requests[1]!.messages.find((m) => m.role === 'system')!.content.endsWith('Write in Nederlands.')).toBe(true)
    expect(view.ai).toMatchObject({ language: 'nl', stale: null })
  })
})

describe('the model for the tips', () => {
  it('is the cheap one for Claude, else the model for reading files, with no setting of its own', () => {
    expect(resolveProvider(DEFAULT_SETTINGS).insightsModel).toBe(CLAUDE_PDF_MODEL)
    expect(resolveProvider({ ...DEFAULT_SETTINGS, aiProvider: 'ollama', aiChatModel: 'llama3' }).insightsModel).toBe('llama3')
    expect(resolveProvider({ ...DEFAULT_SETTINGS, aiProvider: 'ollama', aiChatModel: 'llama3', aiCsvModel: 'llama3-small', aiPdfModel: 'other' }).insightsModel).toBe('llama3-small')
  })
})
