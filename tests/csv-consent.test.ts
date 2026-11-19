import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { analyze, remap } from '@core/import'
import { createRule } from '@core/finance'
import { setSecret } from '@core/secrets'
import { getSettings, resetImportedSettings, updateSettings } from '@core/settings'
import { findIbans } from '@shared/iban'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: vi.fn() } }] },
  powerMonitor: { on: vi.fn() }
}))

// All data here is invented.
const OWN = 'BE68539007547034'
const IBAN = 'NL91ABNA0417164300'
type Body = { messages: { role: string; content: string }[] }
const requests: Body[] = []
const userText = (b: Body): string => b.messages.find((m) => m.role === 'user')!.content
const reply = (content: string): Response => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const EMPTY_PLAN = JSON.stringify({ mapping: null, fixes: [], groups: [], rules: [], notes: ['Checked.'] })
const MAPPING = { delimiter: ';', headerRow: 0, dateOrder: 'YMD', decimal: ',', invertSign: false, columns: { bookingDate: 0, counterpartyName: 1, description: [2], amount: 3 } } as const

async function mockFetch(): Promise<void> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  requests.length = 0
  fetch.mockImplementation(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body) as Body)
    return reply(EMPTY_PLAN)
  })
}

const HOLDER = ['Ilse Vermeulen', 'Kerkstraat 12', '8000 Gent', 'Klantnummer 4455667', IBAN]

function setup(preamble: string[] = []): { db: Db; sessionId: string } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-consent-')), 'k.db'), randomBytes(32).toString('hex'))
  const accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm', aiCsvModel: 'file-m' })
  const csv = [
    ...preamble,
    'Date;Payee;Memo;Amount',
    `2026-10-01;REF${IBAN};Card 5412 7512 3412 3456 Shop;-4,00`,
    `2026-10-02;Bakery Roos;Transfer to ${IBAN} ref 12345678901234;-5,00`,
    '2026-10-03;Cafe Noord;card;-6,00'
  ].join('\n')
  const p = analyze(db, { fileName: 'export 20261001123456789.csv', bytes: new TextEncoder().encode(csv), accountId })
  remap(db, p.sessionId, { ...MAPPING, headerRow: preamble.length })
  // A note from before notes were checked for numbers, and a rule with a long number in it.
  db.prepare("INSERT INTO memories (text, source) VALUES (?, 'person')").run(`Rent is paid to ${IBAN}, mandate 9876543210987654`)
  const category = (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id
  createRule(db, { field: 'description', pattern: 'mandate 9876543210987654', categoryId: category, applyToExisting: false })
  return { db, sessionId: p.sessionId }
}

const code = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: { code?: string }) => e.code)

beforeEach(() => {
  requests.length = 0
})

describe('what a check sends', () => {
  it('is what the preview shows, to the letter', async () => {
    const { checkPreview, assistImport } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    await mockFetch()
    const info = checkPreview(db, sessionId)
    await assistImport(db, sessionId, { consent: true })
    expect(requests).toHaveLength(1)
    expect(userText(requests[0]!)).toBe(info.text)
    expect(info).toMatchObject({ parts: 1, rows: 3, providerName: 'Mistral', company: 'Mistral AI', address: 'api.mistral.ai', model: 'file-m' })
    expect(info.approxTokens).toBeGreaterThan(0)
    // The sections are the keys of what is sent.
    expect(Object.keys(JSON.parse(info.text) as object)).toEqual(expect.arrayContaining(['account', 'fileName', 'header', 'firstRows', 'groups', 'categories', 'rules', 'personNotes']))
  })

  it('holds no account number and no run of 13 or more digits, in any field', async () => {
    const { assistImport } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    await mockFetch()
    await assistImport(db, sessionId, { consent: true })
    const body = userText(requests[0]!)
    expect(findIbans(body)).toEqual([])
    expect(body).not.toContain(IBAN)
    expect(body).not.toMatch(/\d(?:[ -]?\d){12,}/)
    // The payee is still readable; only the number is shortened.
    expect(body).toContain('NL…4300')
    expect(body).toContain('Bakery Roos')
  })

  it('also hides e-mail, phone numbers, spaced IBANs with 00 groups and the account number of a rule', async () => {
    const { assistImport } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    db.prepare("INSERT INTO memories (text, source) VALUES (?, 'person')").run('Mail ilse@example.test or call +32 475 12 34 56, rent to DE89 3704 0044 0532 0130 00')
    createRule(db, { field: 'iban', pattern: IBAN, categoryId: (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id, applyToExisting: false })
    await mockFetch()
    await assistImport(db, sessionId, { consent: true })
    const body = userText(requests[0]!)
    for (const secret of ['ilse@', 'example.test', '475 12', 'DE89', '3704', '0532', 'ABNA', '0417']) expect(body).not.toContain(secret)
    expect(body).toContain('DE…3000')
    expect(JSON.parse(body).rules).toContain('iban contains "NL…4300" → ' + (db.prepare("SELECT category_id FROM rules WHERE field = 'iban'").get() as { category_id: number }).category_id)
  })

  it('leaves out the lines above the header, in the request and in the preview', async () => {
    const { checkPreview, assistImport } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup(HOLDER.map((l) => `${l};;;`))
    await mockFetch()
    const info = checkPreview(db, sessionId)
    await assistImport(db, sessionId, { consent: true })
    const sent = userText(requests[0]!)
    expect(sent).toBe(info.text)
    for (const text of [sent, info.text, JSON.stringify(requests[0])]) {
      for (const secret of ['Ilse Vermeulen', 'Kerkstraat', 'Gent', '4455667', 'NL91', IBAN]) expect(text).not.toContain(secret)
    }
    const body = JSON.parse(sent) as Record<string, unknown>
    expect(body).not.toHaveProperty('linesAboveHeader')
    // The model still learns where the header is, and still gets the header and the rows.
    expect(body).toMatchObject({ headerRow: HOLDER.length, header: ['0: Date', '1: Payee', '2: Memo', '3: Amount'] })
    expect(JSON.stringify(body.firstRows)).toContain('Bakery Roos')
  })

  it('also shows the address in full for a server the person pointed somewhere', async () => {
    const { checkPreview } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    updateSettings(db, { aiProvider: 'custom-abc123', aiBaseUrl: 'http://192.168.1.20:8080/v1', aiChatModel: 'local' })
    expect(checkPreview(db, sessionId)).toMatchObject({ address: 'http://192.168.1.20:8080/v1', model: 'file-m' })
  })
})

describe('consent to check a file', () => {
  it('is needed before anything is sent, then stored and not asked again', async () => {
    const { assistImport, CHECK_CONSENT_VERSION } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    await mockFetch()
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    expect(requests).toHaveLength(0)
    expect(getSettings(db).aiCheckConsent).toBeNull()
    await assistImport(db, sessionId, { consent: true })
    expect(getSettings(db).aiCheckConsent).toMatchObject({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'file-m', version: CHECK_CONSENT_VERSION })
    expect(Date.parse(getSettings(db).aiCheckConsent!.at)).not.toBeNaN()
    await assistImport(db, sessionId)
    expect(requests).toHaveLength(2)
  })

  it('is asked again for another provider, address or model, but not for the same address written differently', async () => {
    const { assistImport } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    await mockFetch()
    updateSettings(db, { aiProvider: 'custom-abc123', aiBaseUrl: 'http://localhost:8080/v1', aiChatModel: 'local', aiCsvModel: 'big' })
    await assistImport(db, sessionId, { consent: true })
    updateSettings(db, { aiBaseUrl: 'HTTP://localhost:8080/v1/' })
    await assistImport(db, sessionId)
    expect(requests).toHaveLength(2)
    updateSettings(db, { aiBaseUrl: 'http://192.168.1.20:8080/v1' })
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    await assistImport(db, sessionId, { consent: true })
    updateSettings(db, { aiCsvModel: 'small' })
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    await assistImport(db, sessionId, { consent: true })
    setSecret(db, 'aiKey.groq', 'other-key')
    updateSettings(db, { aiProvider: 'groq', aiChatModel: 'g', aiCsvModel: 'small' })
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    expect(requests).toHaveLength(4)
  })

  it('is asked again for a record from an older list of what is sent, or one without an address', async () => {
    const { assistImport, CHECK_CONSENT_VERSION } = await import('../src/main/assistant/csv')
    const { db, sessionId } = setup()
    await mockFetch()
    const now = { provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'file-m', at: '2026-01-01T00:00:00.000Z' }
    updateSettings(db, { aiCheckConsent: { ...now, version: CHECK_CONSENT_VERSION - 1 } })
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    updateSettings(db, { aiCheckConsent: { provider: 'mistral', version: CHECK_CONSENT_VERSION, at: now.at } as never })
    expect(await code(assistImport(db, sessionId))).toBe('import.consent_needed')
    expect(requests).toHaveLength(0)
    updateSettings(db, { aiCheckConsent: { ...now, version: CHECK_CONSENT_VERSION } })
    await assistImport(db, sessionId)
    expect(requests).toHaveLength(1)
  })

  it('is cleared by the reset after an import', async () => {
    const { db } = setup()
    updateSettings(db, { aiCheckConsent: { provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'file-m', version: 1, at: '2026-01-01T00:00:00.000Z' } })
    resetImportedSettings(db)
    expect(getSettings(db).aiCheckConsent).toBeNull()
  })
})

describe('edits during a PDF read', () => {
  it('counts the rows the person changed, not the ones a check changed', async () => {
    const { updateRows, setCheck, preview } = await import('@core/import')
    const { db, sessionId } = setup()
    expect(preview(db, sessionId).edited).toBe(0)
    updateRows(db, sessionId, [{ index: 0, description: 'mine' }, { index: 1, description: 'mine too' }])
    expect(preview(db, sessionId).edited).toBe(2)
    const summary = { by: 'x', alreadyImported: 0, total: 3, mappingChanged: false, rules: [], existing: [], dropped: [], applied: null }
    setCheck(sessionId, { summary, before: { overrides: new Map(), mapping: null, mappingSource: 'detected' }, parts: { categories: [], names: [0], fixes: [] }, existingIds: new Map() })
    expect(preview(db, sessionId).edited).toBe(1)
  })
})
