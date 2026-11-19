import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@core/database'
import { openXmlSession } from '@core/camt/open'
import { analyze, remap } from '@core/import'
import { insertTransaction, listRules } from '@core/finance'
import { coreOps, runOp } from '@core/ops'
import { extractText } from '@core/pdf/extract'
import { updateSettings } from '@core/settings'
import type { OpName } from '@shared/contract'
import { maskContacts } from '@shared/iban'
import { compactResult, describeChange, maskResult } from '../src/main/assistant/tools'
import { openPdfSession } from '../src/main/pdf/open'
import { makePdf } from './helpers/make-pdf'
import { HEADER, statementPage } from './helpers/statement-pdf'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: vi.fn() } }] },
  powerMonitor: { on: vi.fn() }
}))

// All data here is invented. The IBANs are the published example numbers of the IBAN standard.
const OWN = 'BE68539007547034'
const OTHER = 'NL91ABNA0417164300'
const OTHER_SPACED = 'NL91 ABNA 0417 1643 00'
const CARD = '5412 7512 3412 3456'
const MAIL = 'ilse.vermeulen@example.test'
const PHONE = '+32 475 12 34 56'
const HOLDER = ['Ilse Vermeulen', 'Kerkstraat 12', '8000 Gent', 'Klantnummer 4455667']
const SECRETS = [OWN, OTHER, OTHER_SPACED, CARD, '5412751234123456', MAIL, PHONE, ...HOLDER.slice(0, 3)]

/** The same steps the chat and the MCP bridge take: run the operation as the assistant, then compactResult. */
async function asAssistant(db: Db, op: OpName, input: unknown = {}): Promise<{ ok: boolean; text: string }> {
  const r = await runOp(coreOps, { db, actor: 'assistant' }, op, input)
  return r.ok ? { ok: true, text: compactResult(op, r.data, input) } : { ok: false, text: r.error.message }
}
const noSecrets = (text: string): void => {
  for (const s of SECRETS) expect(text, s).not.toContain(s)
}

let db: Db
let accountId: number
let txId: number

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-mask-')), 'k.db'), randomBytes(32).toString('hex'))
  accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  txId = insertTransaction(db, {
    accountId,
    bookingDate: '2026-10-01',
    amountCents: -1250,
    description: `Card ${CARD} Shop, mail ${MAIL}, call ${PHONE}, to ${OTHER_SPACED}`,
    counterpartyName: 'Bakery Roos',
    counterpartyIban: OTHER,
    communication: `ref ${OTHER}`,
    notes: `paid by ${MAIL}`
  })
})

describe('what the assistant gets from operations', () => {
  it('hides account and card numbers, e-mail and phone in transactions, and keeps the rest', async () => {
    for (const [op, input] of [['transactions.list', {}], ['transactions.get', { id: txId }], ['transactions.search', { query: 'Bakery' }]] as [OpName, unknown][]) {
      if (!coreOps[op]) continue
      const r = await asAssistant(db, op, input)
      expect(r.ok, `${op}: ${r.text}`).toBe(true)
      noSecrets(r.text)
      expect(r.text).toContain('Bakery Roos')
      expect(r.text).toContain('-1250')
      expect(r.text).toContain('2026-10-01')
    }
    const list = await asAssistant(db, 'transactions.list', {})
    expect(list.text).toContain('NL…4300')
  })

  it('shows an own account number as CC…1234 and keeps balances', async () => {
    const r = await asAssistant(db, 'accounts.list')
    noSecrets(r.text)
    const [a] = JSON.parse(r.text) as { iban: string; balanceCents: number; name: string }[]
    expect(a).toMatchObject({ iban: 'BE…7034', balanceCents: -1250, name: 'Main' })
    const made = await asAssistant(db, 'accounts.create', { name: 'Savings', iban: OTHER, currency: 'EUR', kind: 'savings' })
    noSecrets(made.text)
    expect(JSON.parse(made.text)).toMatchObject({ name: 'Savings', iban: 'NL…4300' })
  })

  it('leaves ids, uids, currencies and names alone', () => {
    const uid = '4455-6677-8899-0011-2233-4455'
    const out = JSON.parse(compactResult('transactions.get' as OpName, { id: 12345678901234, uid, currency: 'EUR', categoryName: 'Groceries', date: '2026-10-01' })) as Record<string, unknown>
    expect(out).toEqual({ id: 12345678901234, uid, currency: 'EUR', categoryName: 'Groceries', date: '2026-10-01' })
  })

  it('never throws on odd values', () => {
    for (const v of [null, undefined, 3, true, [], [null, [undefined]], { iban: null, pattern: 5, field: 'iban' }, { iban: 'x' }, { iban: '' }]) {
      expect(() => compactResult('budgets.list' as OpName, v)).not.toThrow()
    }
    expect(maskResult({ iban: 'XX12' })).toEqual({ iban: 'XX12' })
  })

  it('keeps the result within its cap and says where to continue', async () => {
    for (let i = 0; i < 400; i++) insertTransaction(db, { accountId, bookingDate: '2026-09-01', amountCents: -i - 1, description: `Item ${i} ${OTHER} ${'x'.repeat(100)}`, counterpartyName: `Shop ${i}` })
    const r = await asAssistant(db, 'transactions.list', { limit: 400 })
    expect(r.text.length).toBeLessThanOrEqual(60_000)
    expect(JSON.parse(r.text)).toMatchObject({ truncated: true })
    noSecrets(r.text)
  })

  it('hides numbers in recurring, review and rule previews, also before shortening', async () => {
    const long = `${'a'.repeat(50)} ${OTHER}`
    for (const m of ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']) insertTransaction(db, { accountId, bookingDate: m, amountCents: -999, description: long, counterpartyName: null })
    const rec = await asAssistant(db, 'recurring.list')
    expect(rec.text).not.toMatch(/NL91|ABNA|0417164300/)
    const prev = await asAssistant(db, 'rules.preview', { field: 'description', pattern: 'aaaa' })
    expect(prev.ok).toBe(true)
    expect(prev.text).not.toMatch(/NL91|ABNA|0417164300/)
    const rev = await asAssistant(db, 'summary.review', { month: '2026-10' })
    expect(rev.text).not.toMatch(/NL91|ABNA|0417164300/)
  })

  it('drops backup places and base URLs from the settings', async () => {
    updateSettings(db, { autoBackupFolder: '/home/ilse/backups', aiBaseUrl: 'http://192.168.1.9:1234/v1' })
    const r = await asAssistant(db, 'settings.get')
    expect(r.text).not.toMatch(/ilse|192\.168|autoBackupFolder|lastBackupFile|aiBaseUrl|baseUrl/)
    expect(JSON.parse(r.text)).toHaveProperty('currency')
  })
})

describe('rules on account numbers', () => {
  const groceries = (): number => (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id

  it('are listed with a masked pattern, and created from a transaction', async () => {
    const made = await asAssistant(db, 'rules.create', { field: 'iban', fromTransactionId: txId, categoryId: groceries() })
    expect(made.ok, made.text).toBe(true)
    expect(made.text).toContain('NL…4300')
    noSecrets(made.text)
    expect(listRules(db)[0]!.pattern).toBe(OTHER)
    const list = await asAssistant(db, 'rules.list')
    expect(list.text).toContain('NL…4300')
    expect(list.text).not.toContain(OTHER)
    // The rule works on the transaction it came from.
    expect((db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txId) as { category_id: number }).category_id).toBe(groceries())
  })

  it('refuse a masked or invalid account number and point to fromTransactionId', async () => {
    for (const pattern of ['NL…4300', 'NL91ABNA0000000000']) {
      const r = await asAssistant(db, 'rules.create', { field: 'iban', pattern, categoryId: groceries() })
      expect(r.ok).toBe(false)
      expect(r.text).toContain('fromTransactionId')
    }
    expect(listRules(db)).toHaveLength(0)
  })

  it('accept a whole valid account number the person typed, and update from a transaction', async () => {
    const made = await asAssistant(db, 'rules.create', { field: 'iban', pattern: OTHER_SPACED, categoryId: groceries(), applyToExisting: false })
    expect(made.ok, made.text).toBe(true)
    const id = listRules(db)[0]!.id
    const other = insertTransaction(db, { accountId, bookingDate: '2026-10-02', amountCents: -5, description: 'x', counterpartyIban: 'DE89370400440532013000' })
    const upd = await asAssistant(db, 'rules.update', { id, field: 'iban', fromTransactionId: other })
    expect(upd.ok, upd.text).toBe(true)
    expect(listRules(db)[0]!.pattern).toBe('DE89370400440532013000')
  })

  it('give clear errors for a transaction without an account number, or a text field', async () => {
    const none = insertTransaction(db, { accountId, bookingDate: '2026-10-02', amountCents: -5, description: 'x' })
    expect((await asAssistant(db, 'rules.create', { field: 'iban', fromTransactionId: none, categoryId: groceries() })).ok).toBe(false)
    expect((await asAssistant(db, 'rules.create', { field: 'description', fromTransactionId: txId, categoryId: groceries() })).ok).toBe(false)
    expect((await asAssistant(db, 'rules.create', { field: 'description', categoryId: groceries() })).ok).toBe(false)
  })

  it('show the person the whole account number on the confirmation card', () => {
    expect(describeChange(db, 'rules.create', { field: 'iban', fromTransactionId: txId, categoryId: groceries() })).toContain(OTHER)
  })
})

describe('imports the assistant sees', () => {
  it('returns no info lines of a CSV above the header, only how many', async () => {
    const csv = [...HOLDER, `Account ${OWN}`, 'Date;Payee;Memo;Amount', `2026-10-01;Cafe;Card ${CARD} ${MAIL};-4,00`, `2026-10-02;REF${OTHER};Tel ${PHONE};-5,00`].join('\n')
    const p = analyze(db, { fileName: `export ${OTHER}.csv`, bytes: new TextEncoder().encode(csv), accountId })
    remap(db, p.sessionId, { delimiter: ';', headerRow: 5, dateOrder: 'YMD', decimal: ',', invertSign: false, columns: { bookingDate: 0, counterpartyName: 1, description: [2], amount: 3 } }, 'manual')
    const raw = await asAssistant(db, 'import.raw', { from: 0, count: 10 })
    noSecrets(raw.text)
    expect(raw.text).not.toMatch(/Klantnummer|preamble"/)
    expect(JSON.parse(raw.text)).toMatchObject({ headerRow: 5, preambleLines: 5, totalRows: 2 })
    const cur = await asAssistant(db, 'import.current')
    noSecrets(cur.text)
    expect(cur.text).toContain('Cafe')
    expect(cur.text).not.toContain(OTHER)
  })

  it('masks the grid of an XML statement', async () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>S1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id><Ccy>EUR</Ccy></Acct>` +
      `<Ntry><Amt Ccy="EUR">45.10</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-03-04</Dt></BookgDt><ValDt><Dt>2026-03-04</Dt></ValDt><NtryDtls><TxDtls><Refs><AcctSvcrRef>REF${OTHER}</AcctSvcrRef></Refs>` +
      `<RltdPties><Cdtr><Nm>Boulangerie Dupont</Nm></Cdtr><CdtrAcct><Id><IBAN>${OTHER}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>Pain ${MAIL} ${CARD}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`
    openXmlSession(db, { fileName: 'statement.xml', accountId, bytes: new TextEncoder().encode(xml) })
    for (const op of ['import.raw', 'import.current'] as const) {
      const r = await asAssistant(db, op)
      expect(r.ok, r.text).toBe(true)
      noSecrets(r.text)
      expect(r.text).toContain('Boulangerie Dupont')
    }
    expect((await asAssistant(db, 'import.raw')).text).toContain('NL…4300')
  })

  it('masks the grid of a PDF statement', async () => {
    const pdf = makePdf([
      statementPage([
        ['Statement of account'],
        [`${HOLDER[0]} ${MAIL}`],
        [`Account ${OWN}`],
        HEADER,
        ['03/11/2026', `Payment ${OTHER_SPACED} ${CARD}`, '12.50', '', '987.50'],
        ['05/11/2026', `Call ${PHONE}`, '', '20.00', '1007.50']
      ])
    ])
    await openPdfSession(db, { fileName: 'statement.pdf', accountId, contentBase64: Buffer.from(pdf).toString('base64'), read: (b) => extractText(b) })
    for (const op of ['import.raw', 'import.current'] as const) {
      const r = await asAssistant(db, op)
      expect(r.ok, r.text).toBe(true)
      noSecrets(r.text)
    }
    expect((await asAssistant(db, 'import.raw')).text).toContain('NL…4300')
  })
})

describe('shared masking helper', () => {
  it('hides e-mail addresses and +/00 phone numbers', () => {
    expect(maskContacts(`${MAIL} ${PHONE}`)).toBe('…@… …phone…')
  })
})
