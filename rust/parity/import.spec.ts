// Differential import scenarios (milestone M2, slice 3a): invented CSV and CAMT files go through the app's own dispatch
// (TypeScript: src/core/import.ts, src/core/csv, src/core/camt) and through kb-core (Rust: kb-import and `kb_core::import`) on a
// fresh invented encrypted database. Every op result (the previews with their rows and statuses) and a dump of all tables must be
// equal. Hostile inputs (huge cells, deep XML, entity bombs, unreadable encodings) must give the same error codes.
import { appendFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { comparer } from './compare'
import type { MockState } from './electron-mock'
import { tempDir } from './helpers'
import type { Scenario, Step } from './scenario-runner'
import * as d from './import-data'

process.env.TZ = 'UTC'
const state = vi.hoisted((): MockState => ({ userData: '', db: null, unlocked: true, languages: ['en'] }))
vi.mock('electron', async () => (await import('./electron-mock')).electronMock(state))
vi.mock('../../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../../src/main/session', async () => (await import('./electron-mock')).sessionMock(state))

const tmp = tempDir('kb-imp-files-')
afterAll(() => tmp.remove())
const compare = comparer(state, tmp.dir)
/** Timings go to the file named by KB_PERF_LOG (vitest hides console output of passing tests). */
const report = (line: string): void => void (process.env.KB_PERF_LOG ? appendFileSync(process.env.KB_PERF_LOG, line + '\n') : console.log(line))

// ---------------------------------------------------------------------------------------------------------- steps

const step = (op: string, input?: unknown, actor?: Step['actor']): Step => ({ op, input, actor })
const SETUP: Step[] = [
  step('accounts.create', { name: 'Checking', bank: 'Invented Bank', iban: 'BE68 5390 0754 7034', currency: 'EUR', openingBalanceCents: 100_000 }),
  step('accounts.create', { name: 'Savings', bank: 'Invented Bank', iban: 'BE71096123456769', currency: 'EUR', kind: 'savings' }),
  step('accounts.create', { name: 'Travel USD', bank: 'Dollar Co', currency: 'USD' }),
  step('accounts.create', { name: 'Broker', bank: 'Invented Broker', currency: 'EUR', kind: 'investment' }),
  step('@sql', {
    sql: `INSERT INTO rules (field, pattern, category_id, match, priority) VALUES
      ('counterparty', 'delhaize', (SELECT id FROM categories WHERE name = 'Groceries'), 'contains', 0),
      ('any', 'spotify', (SELECT id FROM categories WHERE name = 'Groceries'), 'word', 0),
      ('description', 'salary', (SELECT id FROM categories WHERE name = 'Groceries'), 'contains', 1)`
  })
]
const bytes = (data: string | Uint8Array): string => d.b64(data)
const analyze = (fileName: string, data: string | Uint8Array, accountId = 1, actor?: Step['actor']): Step =>
  step('import.analyze', { fileName, contentBase64: bytes(data), accountId }, actor)
const analyzeXml = (fileName: string, data: string | Uint8Array, accountId = 1): Step => step('import.analyzeXml', { fileName, contentBase64: bytes(data), accountId })
const commit = (saveProfile?: boolean): Step => step('import.commit', saveProfile === undefined ? {} : { saveProfile })
const current = (): Step => step('import.current')
const update = (changes: unknown[], actor?: Step['actor']): Step => step('import.updateRows', { changes }, actor)
const scenarios: [string, Step[]][] = []
const add = (name: string, steps: Step[], extraSetup: Step[] = []): void => void scenarios.push([name, [...SETUP, ...extraSetup, ...steps]])

// -------------------------------------------------------------------------------------------------- CSV: file shapes

add('csv comma, ISO dates, dot decimals', [analyze('comma.csv', d.commaIso()), commit(), step('import.batches')])
add('csv semicolon, Windows-1252, Belgian amounts, structured communication', [analyze('be.csv', d.belgian()), commit(true), step('import.batches')])
add('csv tab-delimited, day first', [analyze('tab.csv', d.tabbed()), commit()])
add('csv pipe-delimited, US dates are detected', [analyze('pipe.csv', d.piped()), commit()])
add('csv Dutch ING: YYYYMMDD, Af/Bij, balance column, thousands dots', [analyze('ing.csv', d.dutchIng()), commit(), step('balances.list', { accountId: 1 })])
add('csv German Sparkasse: all fields quoted, two-digit years, Latin-1', [analyze('sparkasse.csv', d.germanSparkasse()), commit()])
add('csv French: debit and credit columns, no-break space thousands', [analyze('fr.csv', d.french()), commit(), step('balances.list', { accountId: 1 })])
add('csv Revolut-like: date-times, currency column, cancelled state', [analyze('rev.csv', d.revolutLike()), commit()])
add('csv UTF-8 with a byte order mark', [analyze('bom.csv', d.utf8bom(d.commaIso().replace('Coffee beans', 'Café crème'))), commit()])
add('csv UTF-16 little endian with a mark', [analyze('u16le.csv', d.utf16le(d.commaIso().replace('Coffee beans', 'Café crème')))])
add('csv UTF-16 big endian with a mark', [analyze('u16be.csv', d.utf16be(d.commaIso().replace('Coffee beans', 'Café crème')))])
add('csv UTF-16 without a mark falls back to Windows-1252 garbage', [analyze('u16nobom.csv', d.utf16le(d.commaIso(), false))])
add('csv two byte order marks in a row', [analyze('bom2.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), d.utf8bom(d.commaIso())]))])
add('csv invalid UTF-8 is Windows-1252, including the undefined bytes', [analyze('bad.csv', Buffer.concat([d.latin1('Date,Description,Amount\n2026-01-01,Caf'), Buffer.from([0xe9, 0x81, 0x8d, 0x80, 0x9f]), d.latin1(',-5.00\n2026-01-02,Two,-6.00\n')]))])
add('csv quoted fields, doubled quotes, line breaks inside a field', [analyze('quoted.csv', d.quoted()), commit()])
add('csv preamble lines above the header (header row found)', [analyze('pre.csv', d.withPreamble()), step('import.raw', { from: 0, count: 2 }), commit()])
add('csv line endings: CRLF, LF, lone CR', [analyze('crlf.csv', d.lineEndings('\r\n')), analyze('lf.csv', d.lineEndings('\n'), 2), analyze('cr.csv', d.lineEndings('\r'), 3)])
add('csv empty lines, short rows, extra cells', [analyze('short.csv', d.emptyAndShort())])
for (const [bank, text] of Object.entries(d.BANK_FILES)) add(`csv bank layout ${bank}`, [analyze(`${bank}.csv`, text), commit()])
add('csv fixtures of the app: argenta, hellobank, keytrade, generic', [
  analyze('argenta.csv', d.fixture('argenta.csv')),
  analyze('hellobank.csv', d.fixture('hellobank.csv'), 2),
  analyze('keytrade.csv', d.fixture('keytrade.csv'), 3),
  analyze('generic.csv', d.fixture('generic.csv'), 4)
])

// ----------------------------------------------------------------------------------- CSV: amounts, dates, columns

add('csv negative formats and currency signs', [analyze('neg.csv', d.negatives()), commit()])
add('csv UK DR/CR suffixes and a balance', [analyze('uk.csv', d.ukDrCr()), commit()])
add('csv direction column S/H', [analyze('dir.csv', d.directionColumn()), commit()])
add('csv debit and credit columns with an empty amount column', [analyze('dc.csv', d.debitCredit()), commit()])
add('csv bad rows: impossible date, no date, bad amount, zero, refused, cancelled, short', [analyze('bad.csv', d.badRows()), commit()])
add('csv named months in several languages and a prototype name', [analyze('months.csv', d.namedMonths()), commit()])
add('csv other currencies are flagged and imported in the account currency', [analyze('multi.csv', d.multiCurrency()), commit()])
add('csv multi-currency into a USD account', [analyze('multi.csv', d.multiCurrency(), 3), commit()])
add('csv bank references: unique, repeated, placeholders', [analyze('refs.csv', d.references()), commit(), analyze('refs2.csv', d.references())])
add('csv structured communications and IBAN swaps', [analyze('ogm.csv', d.ogm()), analyze('ibans.csv', d.lowercaseIbans(), 2)])
add('csv seven description columns make the detection fail (op.failed)', [analyze('seven.csv', d.sevenDescriptions()), current()])

// ------------------------------------------------------------------------------------------- CSV: duplicates

add('duplicates: the same file twice, saved mapping, include on purpose', [
  analyze('a.csv', d.commaIso()),
  commit(true),
  analyze('a.csv', d.commaIso()),
  update([{ index: 0, decided: 'include' }]),
  commit(false)
])
add('duplicates: another layout of the same transactions', [analyze('a.csv', d.commaIso()), commit(), analyze('b.csv', d.duplicateColumnsReordered())])
add('duplicates: identical coffees count by number', [analyze('c2.csv', d.identicalCoffees(2)), commit(), analyze('c3.csv', d.identicalCoffees(3)), analyze('c1.csv', d.identicalCoffees(1))])
add('duplicates: possible duplicates a few days apart with similar text', [analyze('a.csv', d.commaIso()), commit(), analyze('s.csv', d.shiftedDates()), update([{ index: 0, decided: 'skip' }, { index: 1, decided: 'include' }])])
add('duplicates: pending first, then booked with a reference', [
  analyze('p1.csv', d.csv([['Date', 'Description', 'Amount', 'Reference'], ['2026-09-04', 'Pending coffee', '-4.00', '2026-']], ',')),
  commit(),
  analyze('p2.csv', d.csv([['Date', 'Description', 'Amount', 'Reference'], ['2026-09-04', 'Pending coffee', '-4.00', 'BANK-77']], ',')),
  commit(),
  analyze('p3.csv', d.csv([['Date', 'Description', 'Amount', 'Reference'], ['2026-09-04', 'Pending coffee', '-4.00', 'BANK-78']], ','))
])
add('duplicates: a different real reference is a different payment', [
  analyze('r1.csv', d.csv([['Date', 'Description', 'Amount', 'Reference'], ['2026-09-04', 'Parking', '-4.00', 'BANK-1']], ',')),
  commit(),
  analyze('r2.csv', d.csv([['Date', 'Description', 'Amount', 'Reference'], ['2026-09-05', 'Parking', '-4.00', 'BANK-2'], ['2026-09-05', 'Parking', '-4.00', 'BANK-1']], ','))
])
add('duplicates: only the account of the session counts', [analyze('a.csv', d.commaIso()), commit(), analyze('a.csv', d.commaIso(), 2)])

// ---------------------------------------------------------------------------- CSV: rules, names, categories

add('rules: first match wins, bank text and readable text, categories set by hand', [
  analyze('be.csv', d.belgian()),
  update([{ index: 0, categoryId: 2 }, { index: 1, categoryId: null }, { index: 3, categoryId: 1, note: 'checked' }]),
  commit()
])
add('rules: assistant sets categories (categorySource)', [analyze('be.csv', d.belgian()), update([{ index: 0, categoryId: 2 }], 'assistant'), current()])
add('names: a tidied name is used again for the same bank text', [
  analyze('a.csv', d.csv([['Date', 'Description', 'Amount'], ['2026-03-01', 'ZZ SHOP 0123 BRUGGE', '-9.00']], ',')),
  commit(),
  step('transactions.rename', { ids: [1], counterpartyName: 'Z Shop' }),
  step('transactions.update', { id: 1, description: 'Shopping' }),
  analyze('b.csv', d.csv([['Date', 'Description', 'Amount'], ['2026-04-01', 'ZZ SHOP 0123 BRUGGE', '-9.00'], ['2026-04-02', 'ZZ SHOP 0123 BRUGGE', '-3.00']], ','))
])

// -------------------------------------------------------------------------------- CSV: remap, updateRows, commit

add('remap: columns, date order, decimal, invertSign, header row', [
  analyze('a.csv', d.commaIso()),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: true, columns: { bookingDate: 0, amount: 2, description: [1] } } }),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'MDY', decimal: ',', invertSign: false, columns: { bookingDate: 0, amount: 2, description: [1, 1, 0], valueDate: 0 } } }),
  commit()
])
add('remap: columns that do not exist, a header row past the end, no amount column, no open import', [
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: false, columns: { bookingDate: 0, amount: 1 } } }),
  analyze('a.csv', d.commaIso()),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: false, columns: { bookingDate: 0, amount: 99 } } }),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 4, dateOrder: 'YMD', decimal: '.', invertSign: false, columns: { bookingDate: 0, amount: 2 } } }),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: false, columns: { bookingDate: 0 } } }),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', columns: { bookingDate: 0, amount: 2 }, extra: 1 } }),
  step('import.remap', { sessionId: '2f6c1e0a-5b8d-4c1e-9a7f-0123456789ab', mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', columns: { bookingDate: 0, amount: 2 } } }),
  step('import.remap', { sessionId: 'not-a-uuid', mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', columns: { bookingDate: 0, amount: 2 } } })
])
add('remap by the assistant records its source', [analyze('a.csv', d.commaIso()), step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', columns: { bookingDate: 0, amount: 2, description: [1] } } }, 'assistant')])
add('updateRows: dates, amounts, descriptions, names, notes, decisions', [
  analyze('bad.csv', d.badRows()),
  update([
    { index: 1, bookingDate: '2026-10-02' },
    { index: 2, bookingDate: '2026-10-03', amountCents: -700 },
    { index: 3, amountCents: -400, description: '  Fixed amount  ' },
    { index: 4, amountCents: 0 },
    { index: 5, decided: 'include' },
    { index: 6, decided: 'skip', note: 'cancelled' },
    { index: 0, counterpartyName: null, decided: null },
    { index: 7, counterpartyName: '  Renamed  ' }
  ]),
  commit()
])
add('updateRows: invalid input and a calendar day the engine cannot shift', [
  analyze('a.csv', d.commaIso()),
  update([{ index: 0, bookingDate: '2026-02-30' }]),
  update([{ index: 1, bookingDate: '2026-13-01' }]),
  update([{ index: 1, bookingDate: '2026-1-1' }]),
  update([{ index: 1, description: '   ' }]),
  update([{ index: -1, note: 'x' }]),
  update([]),
  update([{ index: 1, categoryId: 0 }]),
  update([{ index: 1, unknown: 1 }]),
  update([{ index: 99, note: 'beyond the rows' }]),
  step('import.preview', { sessionId: '$session' })
])
add('commit: nothing ready, no mapping, expired and unknown sessions, discard', [
  commit(),
  analyze('a.csv', d.commaIso()),
  update([0, 1, 2, 3].map((index) => ({ index, decided: 'skip' }))),
  commit(),
  step('import.discard', { sessionId: '$session' }),
  step('import.preview', { sessionId: '$session' }),
  commit(),
  analyze('none.csv', 'one,two\nthree,four\n'),
  commit(),
  current()
])
add('commit: saved mapping is used next time, a damaged saved mapping fails, an invalid one is ignored', [
  analyze('a.csv', d.commaIso()),
  commit(true),
  analyze('a2.csv', d.commaIso().replace('2026-03-0', '2026-04-0')),
  step('@sql', { sql: "UPDATE csv_profiles SET mapping_json = '{\"delimiter\":\",\"}'" }),
  analyze('a3.csv', d.commaIso()),
  step('@sql', { sql: "UPDATE csv_profiles SET mapping_json = 'not json'" }),
  analyze('a4.csv', d.commaIso())
])
add('commit: two files with one header, the profile is updated', [
  analyze('a.csv', d.commaIso()),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: true, columns: { bookingDate: 0, amount: 2, description: [1] } } }),
  commit(true),
  analyze('b.csv', d.commaIso().replace('2026-03', '2026-05')),
  commit(true)
])
add('sessions: one per account, the latest is the current one', [analyze('a.csv', d.commaIso()), analyze('b.csv', d.tabbed(), 2), current(), analyze('c.csv', d.commaIso(), 1), current(), step('import.raw', {})])
add('sessions: current and raw without an open import', [current(), step('import.raw', {}), step('import.raw', { from: 2, count: 3 }), step('import.raw', { count: 0 }), step('import.raw', { from: -1 })])
add('raw: windows of the rows, with the preamble', [analyze('pre.csv', d.withPreamble()), step('import.raw', { from: 1, count: 1 }), step('import.raw', { from: 50, count: 5 })])
add('assistant: current, remap and raw, and the user of the same calls', [
  analyze('pre.csv', d.withPreamble()),
  step('import.current', undefined, 'assistant'),
  step('import.raw', {}, 'user')
])
add('check: apply and undo without a check', [analyze('a.csv', d.commaIso()), step('import.checkApply', { sessionId: '$session', rules: [], existing: [] }), step('import.checkUndo', { sessionId: '$session', part: 'all' }), step('import.checkUndo', { sessionId: '$session', part: 'names' }), step('import.checkApply', { sessionId: '2f6c1e0a-5b8d-4c1e-9a7f-0123456789ab', rules: [], existing: [] }), step('import.checkUndo', { sessionId: '$session', part: 'nope' })])

// ---------------------------------------------------------------------- CSV: balances, transfers, batches, errors

add('balance column, oldest first: recorded and compared with the expected balance', [analyze('bal.csv', d.withBalance(false)), commit(), step('balances.list', { accountId: 1 })], [step('balances.set', { accountId: 1, date: '2026-02-01', balanceCents: 100_000 })])
add('balance column, newest first', [analyze('bal.csv', d.withBalance(true)), commit(), step('balances.list', { accountId: 1 })])
add('balance column in the future: the note says why it is not recorded', [analyze('bal.csv', d.withBalance(false).replaceAll('2026-02', '2031-02')), commit()])
add('balance column on an investment account is not recorded; no balance asked', [analyze('bal.csv', d.withBalance(false), 4), commit()])
add('balance column that does not follow from the rows', [analyze('broken.csv', d.brokenBalance()), commit(), step('balances.list', { accountId: 1 })])
add('transfers between own accounts are paired when the account number matches', [
  analyze('out.csv', d.transferOut(), 1),
  commit(),
  analyze('in.csv', d.transferIn(), 2),
  commit(),
  step('transfers.find'),
  step('transactions.list', { accountId: 2 })
])
add('batches: list and undo', [analyze('a.csv', d.commaIso()), commit(), analyze('b.csv', d.tabbed(), 2), commit(), step('import.batches'), step('import.undo', { batchId: 1 }), step('import.batches'), step('import.undo', { batchId: 99 }), step('import.undo', { batchId: 0 })])
add('errors: unknown account, PDF, empty file, header only, too big', [
  analyze('a.csv', d.commaIso(), 99),
  analyze('a.pdf', '%PDF-1.4\n1 0 obj\n'),
  analyze('empty.csv', ' '),
  analyze('header.csv', 'Date,Amount\n'),
  step('import.analyze', { fileName: '', contentBase64: 'YQ==', accountId: 1 }),
  step('import.analyze', { fileName: 'a.csv', contentBase64: '', accountId: 1 }),
  step('import.analyze', { fileName: 'a.csv', contentBase64: 'YQ==', accountId: 0 }),
  step('import.analyze', { fileName: 'a.csv', contentBase64: 'YQ==', accountId: 1, extra: true }),
  step('import.analyze', { fileName: 'x'.repeat(261), contentBase64: 'YQ==', accountId: 1 }),
  step('import.analyze', { fileName: 'a.csv', contentBase64: '!!!!', accountId: 1 })
])
add('base64: both alphabets, whitespace, padding and trailing text', [
  step('import.analyze', { fileName: 'a.csv', contentBase64: Buffer.from(d.commaIso()).toString('base64').replace(/(.{20})/g, '$1\n'), accountId: 1 }),
  step('import.analyze', { fileName: 'b.csv', contentBase64: Buffer.from(d.commaIso()).toString('base64url'), accountId: 2 }),
  step('import.analyze', { fileName: 'c.csv', contentBase64: Buffer.from(d.commaIso()).toString('base64') + '=garbage', accountId: 3 })
])

// ----------------------------------------------------------------------------------------------- CSV: hostile files

const hugeCell = 'x'.repeat(3_000_000)
add('hostile: a three megabyte cell', [analyze('huge.csv', d.csv([['Date', 'Description', 'Amount'], ['2026-01-01', hugeCell, '-1.00']], ',')), commit()])
add('hostile: a hundred thousand empty columns and a long header', [analyze('wide.csv', 'Date,' + ',x'.repeat(100_000) + ',Amount\n2026-01-01' + ',1'.repeat(100_001) + ',-5.00\n')])
add('hostile: an unterminated quote swallows the rest', [analyze('quote.csv', 'Date,Description,Amount\n2026-01-01,"never closed,-5.00\n2026-01-02,Two,-6.00\n')])
add('hostile: NUL bytes, controls and invalid sequences', [analyze('nul.csv', Buffer.concat([Buffer.from('Date,Description,Amount\n2026-01-01,A'), Buffer.from([0, 1, 2, 0xc0, 0xaf, 0xed, 0xa0, 0x80]), Buffer.from(',-5.00\n2026-01-02,B,-6.00\n')]))])
add('hostile: every byte value', [analyze('bytes.csv', Buffer.concat([Buffer.from('Date,Description,Amount\n2026-01-01,'), Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((i) => i !== 10 && i !== 13 && i !== 34 && i !== 44)), Buffer.from(',-5.00\n2026-01-02,B,-6.00\n')]))])
add('hostile: dates and amounts at the edges', [
  analyze(
    'edges.csv',
    d.csv(
      [
        ['Date', 'Description', 'Amount'],
        ['1989-12-31', 'before range', '-1'],
        ['2100-12-31', 'end of range', '-1'],
        ['2101-01-01', 'after range', '-1'],
        ['0x10-03-2026', 'hex day', '-1'],
        ['1e1-03-2026', 'exponent day', '-1'],
        ['2026-03-1e0', 'exponent', '-1'],
        ['29/02/2024', 'leap', '-1'],
        ['29/02/2023', 'not leap', '-1'],
        ['2026-03-04 12:00', 'with a time', '90071992547409.91'],
        ['2026-03-05', 'too big', '90071992547409.92'],
        ['2026-03-06', 'sixteen digits', '9007199254740991'],
        ['2026-03-07', 'three decimals', '1.005'],
        ['2026-03-08', 'zero decimals', '1.000'],
        ['2026-03-09', 'arabic digits', '١٢٣'],
        ['2026-03-10', 'unicode minus', '−5.00']
      ],
      ','
    )
  ),
  commit()
])
add('hostile: debit and credit sums at the limit of exact doubles', [
  analyze('limit.csv', d.csv([['Date', 'Description', 'Debit', 'Credit'], ['2026-01-01', 'huge', '-2', '9007199254740991'], ['2026-01-02', 'huge2', '9007199254740991', '9007199254740991']], ',')),
  commit()
])
add('hostile: header names that look like object properties', [analyze('proto.csv', 'constructor,__proto__,toString,Date,Amount\n1,2,3,2026-01-01,-5.00\n')])

// -------------------------------------------------------------------------------------------------- CAMT XML files

const camt = (name: string, xml: string | Uint8Array, accountId = 1): Step => analyzeXml(name, xml, accountId)
add('xml: one statement, balances, a USD entry, the closing balance is recorded', [camt('s.xml', d.marchStatement()), commit(), step('balances.list', { accountId: 1 }), camt('s.xml', d.marchStatement())])
add('xml: rows that add up reconcile', [
  camt('a.xml', d.doc(d.stmt([d.ntry({ amt: '40.00' }), d.ntry({ amt: '15.50', dir: 'CRDT' })], { bals: [d.bal('OPBD', '100.00', 'CRDT', '2026-03-01'), d.bal('CLBD', '75.50', 'CRDT', '2026-03-31')] }))),
  commit(false)
])
add('xml: only a real closing balance (CLBD) is recorded', [
  camt('i.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { bals: [d.bal('ITBD', '50.00', 'CRDT', '2026-03-10'), d.bal('CLAV', '999.00', 'CRDT', '2026-03-10')] }))),
  commit(false),
  camt('c.xml', d.doc(d.stmt([d.ntry({ amt: '2.00' })], { bals: [d.bal('PRCD', '80.00', 'DBIT', '2026-02-28'), d.bal('CLBD', '30.00', 'CRDT', '2026-03-31'), d.bal('ITBD', '1.00', 'CRDT', '2026-03-10')] }))),
  commit(false)
])
add('xml: signs are the file’s own, invertSign is ignored, no profile is saved', [
  camt('s.xml', d.marchStatement()),
  step('import.remap', { mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: true, columns: { bookingDate: 0, valueDate: 1, amount: 2, currency: 3, counterpartyName: 4, counterpartyIban: 5, description: [6], communication: 7, bankReference: 8 } } }),
  commit(true)
])
add('xml: several accounts in a file, the chosen one is used', [
  camt('m.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })]) + d.stmt([d.ntry({ amt: '2.00' }), d.ntry({ amt: '3.00' })], { iban: d.OTHER }) + d.stmt([d.ntry({ amt: '4.00' })], { iban: d.OWN }))),
  commit(false)
])
add('xml: statements of one account in date order give opening and closing', [
  camt(
    'm.xml',
    d.doc(
      d.stmt([d.ntry({ amt: '5.00', date: '2026-04-10' })], { bals: [d.bal('OPBD', '90.00', 'CRDT', '2026-04-01'), d.bal('CLBD', '85.00', 'CRDT', '2026-04-30')] }) +
        d.stmt([d.ntry({ amt: '10.00', date: '2026-03-10' })], { bals: [d.bal('OPBD', '100.00', 'CRDT', '2026-03-01'), d.bal('CLBD', '90.00', 'CRDT', '2026-03-31')] })
    )
  ),
  commit(false)
])
add('xml: another account, no IBAN, several accounts, wrong currency', [
  camt('o.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { iban: d.OTHER })), 1),
  camt('o.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { iban: d.OTHER })), 2),
  camt('o.xml', d.doc('<Stmt><Acct><Id><Othr><Id>123-4567890-12</Id></Othr></Id></Acct>' + d.ntry({ amt: '1.00' }) + '</Stmt>'), 1),
  camt('x.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { iban: d.OTHER }) + d.stmt([d.ntry({ amt: '1.00' })], { iban: d.THIRD })), 1),
  camt('x.xml', d.doc(d.stmt([d.ntry({ amt: '7.00', ccy: 'USD' })], { ccy: 'USD' }) + d.stmt([d.ntry({ amt: '2.00' })])), 1),
  camt('x.xml', d.doc(d.stmt([d.ntry({ amt: '7.00', ccy: 'USD' })], { ccy: 'USD' })), 1),
  camt('x.xml', d.doc(d.stmt([d.ntry({ amt: '7.00', ccy: 'USD' })], { ccy: 'USD' })), 3),
  camt('x.xml', d.doc(d.stmt([d.ntry({ amt: '7.00' })]).replace('<Ccy>EUR</Ccy>', '')), 1),
  camt('x.xml', d.marchStatement(), 99)
])
add('xml: entries that are not booked, an empty file, a missing indicator', [
  camt('p.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' }), d.ntry({ amt: '2.00', booked: 'PDNG' }), d.ntry({ amt: '3.00', booked: 'INFO' })]))),
  camt('e.xml', d.doc(d.stmt([]))),
  camt('n.xml', d.doc(d.stmt([d.ntry({ amt: '5.00' }).replace('<CdtDbtInd>DBIT</CdtDbtInd>', ''), d.ntry({ amt: '6.00' })]))),
  commit(false)
])
add('xml: status of version 10 and later, dates with a time, Pty/Nm, ultimate parties', [
  camt(
    'v.xml',
    d.doc(
      d.stmt([
        d.ntry({ amt: '1.00' }).replace('<Sts>BOOK</Sts>', '<Sts><Prtry><Cd>BOOK</Cd></Prtry></Sts>'),
        d.ntry({ amt: '2.00' }).replace('<Sts>BOOK</Sts>', '<Sts><Prtry><Cd>INFO</Cd></Prtry></Sts>'),
        d.ntry({ amt: '3.00' }).replace('<Sts>BOOK</Sts>', '<Sts><Cd>PDNG</Cd></Sts>'),
        d.ntry({ amt: '4.00' }).replace('<Sts>BOOK</Sts>', ''),
        `<Ntry><Amt Ccy="EUR">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><DtTm>2026-03-31T23:30:00-05:00</DtTm></BookgDt>` +
          d.tx('<RltdPties><Cdtr><Pty><Nm>Café Müller-Janssens</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>Déjeuner</Ustrd><Ustrd>à l’école</Ustrd></RmtInf>') +
          '</Ntry>',
        d.ntry({ amt: '1.00', inner: d.tx('<RltdPties><Dbtr><Nm>Debtor Name</Nm></Dbtr><UltmtCdtr><Nm>Ultimate Creditor</Nm></UltmtCdtr></RltdPties>') }),
        d.ntry({ amt: '1.00', dir: 'CRDT', inner: d.tx('<RltdPties><Dbtr><Nm>Debtor Name</Nm></Dbtr><UltmtCdtr><Nm>Ultimate Creditor</Nm></UltmtCdtr></RltdPties>') })
      ]),
      'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08'
    )
  ),
  commit(false)
])
add('xml: description fallbacks, structured references, reversals, parties in the other order', [
  camt(
    'd.xml',
    d.doc(
      d.stmt([
        d.ntry({ amt: '5.00', info: 'BETALING MET DEBETKAART Delhaize Gent' }),
        d.ntry({ amt: '6.00', inner: '<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>' }),
        d.ntry({ amt: '9.00', inner: d.tx('<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>+++090/9337/55493+++</Ref></CdtrRefInf><AddtlRmtInf>Factuur 2026-17</AddtlRmtInf></Strd></RmtInf>') }),
        d.ntry({ amt: '700.00', date: '2026-03-01', inner: d.tx('<Refs><EndToEndId>RENT</EndToEndId></Refs>') }),
        d.ntry({ amt: '700.00', date: '2026-04-01', inner: d.tx('<Refs><EndToEndId>RENT</EndToEndId></Refs>') }),
        d.ntry({ amt: '5.00', inner: d.tx('<Refs><AcctSvcrRef>BANK-1</AcctSvcrRef><EndToEndId>RENT</EndToEndId></Refs>') }),
        d.ntry({
          amt: '5.00',
          dir: 'CRDT',
          rvsl: true,
          inner: d.tx(`<RltdPties><Dbtr><Nm>Me Myself</Nm></Dbtr><DbtrAcct><Id><IBAN>${d.OWN}</IBAN></Id></DbtrAcct><Cdtr><Nm>Shop Vandenberghe</Nm></Cdtr><CdtrAcct><Id><IBAN>${d.OTHER}</IBAN></Id></CdtrAcct></RltdPties>`)
        })
      ])
    )
  ),
  commit(false)
])
const t = (name: string, amt: string, ref: string): string => `<TxDtls><Refs><EndToEndId>${ref}</EndToEndId></Refs><Amt Ccy="EUR">${amt}</Amt><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Salaris ${name}</Ustrd></RmtInf></TxDtls>`
add('xml: a batch is split when the amounts add up, kept whole when not', [
  camt(
    'b.xml',
    d.doc(
      d.stmt([
        d.ntry({ amt: '300.50', inner: `<NtryDtls>${t('Anna', '100.25', 'E1')}${t('Bram', '200.25', 'E2')}</NtryDtls>`, info: 'Collectieve betaling' }),
        d.ntry({ amt: '50.00', inner: `<NtryDtls><TxDtls><RmtInf><Ustrd>Deel x</Ustrd></RmtInf></TxDtls><TxDtls><RmtInf><Ustrd>Deel x</Ustrd></RmtInf></TxDtls></NtryDtls>` }),
        d.ntry({ amt: '50.00', inner: `<NtryDtls>${t('Cor', '10.00', 'E3')}${t('Dirk', '20.00', 'E4')}</NtryDtls>` }),
        d.ntry({ amt: '9007199254740.99', dir: 'CRDT' }),
        d.ntry({ amt: '99999999999999999.99' })
      ])
    )
  ),
  commit(false)
])
add('xml: CAMT.052 and CAMT.054, other namespaces and prefixes, no namespace', [
  camt('r.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { tag: 'Rpt' }), 'urn:iso:std:iso:20022:tech:xsd:camt.052.001.08', 'BkToCstmrAcctRpt'), 1),
  camt('n.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })], { tag: 'Ntfctn' }), 'urn:iso:std:iso:20022:tech:xsd:camt.054.001.02', 'BkToCstmrDbtCdtNtfctn'), 2),
  camt('v13.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })]), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.13'), 3),
  camt('any.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })]), 'http://example.invalid/anything'), 1),
  camt(
    'pfx.xml',
    `<?xml version="1.0"?><c:Document xmlns:c="${d.NS}"><c:BkToCstmrStmt><c:Stmt><c:Acct><c:Id><c:IBAN>${d.OWN}</c:IBAN></c:Id></c:Acct>${d.ntry({ amt: '10.00', dir: 'CRDT' }).replace(/<(\/?)(\w)/g, '<$1c:$2')}</c:Stmt></c:BkToCstmrStmt></c:Document>`,
    1
  )
])
add('xml: refused files', [
  camt('a.xml', 'Date;Amount\n1;2'),
  camt('b.xml', ' '),
  camt('c.xml', '<Document><Other/></Document>'),
  camt('d.xml', d.doc('', 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03')),
  camt('e.xml', d.doc(d.stmt([]), 'urn:iso:std:iso:20022:tech:xsd:camt.056.001.01')),
  camt('f.xml', d.doc(d.stmt([]), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.99')),
  camt('g.xml', d.doc(d.stmt([]), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.00')),
  camt('h.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })]).slice(0, -20))),
  camt('i.xml', '<?xml version="1.0"?><Document><Stmt/><Stmt/>'),
  camt('j.xml', '<a/><b/>'),
  camt('k.xml', '<a>&nbsp;</a>')
])
add('xml: DOCTYPE, entity bombs and external entities', [
  camt('bomb.xml', '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>'),
  camt('xxe.xml', '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>'),
  camt('late.xml', '<?xml version="1.0"?>' + d.doc(d.stmt([])) .replace('<GrpHdr>', '<!DOCTYPE x><GrpHdr>')),
  camt('ent.xml', d.doc(d.stmt([d.ntry({ amt: '1.00', info: '&constructor; &amp; &#233; &#xE9; &toString;' })]))),
  camt('ent2.xml', d.doc(d.stmt([d.ntry({ amt: '1.00', info: 'Fish &amp; chips &#233; &#xE9; &#0; &#x110000; a & b' })]))),
  camt('ent3.xml', d.doc(d.stmt([d.ntry({ amt: '1.00', info: 'Fish &amp; chips &#233; &#xE9; &#128512; a & b &#x1F600;' })])))
])
add('xml: encodings: UTF-8 mark, UTF-16 both ways, declared Latin-1, unknown and odd declarations', [
  camt('u8.xml', d.utf8bom(d.doc(d.stmt([d.ntry({ amt: '1.00', inner: d.tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })])))),
  camt('u16.xml', d.utf16le(d.doc(d.stmt([d.ntry({ amt: '1.00', inner: d.tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })]))), 2),
  camt('u16b.xml', d.utf16be(d.doc(d.stmt([d.ntry({ amt: '1.00', inner: d.tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })])), false), 3),
  camt('l1.xml', d.latin1(d.doc(d.stmt([d.ntry({ amt: '1.00', inner: d.tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })])).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')), 4),
  camt('l15.xml', d.latin1(d.doc(d.stmt([d.ntry({ amt: '1.00', inner: d.tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })])).replace('encoding="UTF-8"', "encoding='iso-8859-15'")), 1),
  camt('w1250.xml', d.latin1(d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('encoding="UTF-8"', 'encoding="windows-1250"')), 2),
  camt('unknown.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('encoding="UTF-8"', 'encoding="klingon"'), 3),
  camt('hz.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('encoding="UTF-8"', 'encoding="hz-gb-2312"'), 4),
  camt('xud.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('encoding="UTF-8"', 'encoding="x-user-defined"'), 1),
  camt('sjis.xml', d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('encoding="UTF-8"', 'encoding="Shift_JIS"'), 2),
  camt('spaced.xml', ' \n' + d.doc(d.stmt([d.ntry({ amt: '1.00' })])).replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml  version="1.0"\n encoding = "latin1" ?>'), 3)
])
add('xml: attributes in a hostile order and prototype names', [
  camt('attr.xml', `<?xml version="1.0"?><Document 5="camt.099.001.02" b="camt.053.001.02" __proto__="x" constructor="y">${d.stmt([d.ntry({ amt: '1.00' })])}</Document>`),
  camt('attr2.xml', `<?xml version="1.0"?><Document a="camt.053.001.02" 7="camt.053.001.99">${d.stmt([d.ntry({ amt: '1.00' })])}</Document>`),
  camt('attr3.xml', `<?xml version="1.0"?><Document a="camt.099.001.02" a="camt.053.001.02">${d.stmt([d.ntry({ amt: '1.00' })])}</Document>`),
  camt('attr4.xml', `<?xml version="1.0"?><Document a="camt.053.001.02" a="camt.099.001.02">${d.stmt([d.ntry({ amt: '1.00' })])}</Document>`)
])
add('xml: duplicates of CSV-imported history, standing orders stay apart', [
  analyze('a.csv', d.csv([['Date', 'Counterparty', 'Description', 'Amount'], ['2026-03-01', 'Landlord Peeters', 'Huur', '-700.00']], ',')),
  commit(),
  camt('r.xml', d.doc(d.stmt([d.ntry({ amt: '700.00', date: '2026-03-01', inner: d.tx(d.payTo('Landlord Peeters', d.OTHER, 'Huur', '<EndToEndId>RENT</EndToEndId>')) }), d.ntry({ amt: '700.00', date: '2026-04-01', inner: d.tx(d.payTo('Landlord Peeters', d.OTHER, 'Huur', '<EndToEndId>RENT</EndToEndId>')) })]))),
  commit(false)
])

// ------------------------------------------------------------------------------------------------ XML: limits

add('limits: nesting, a long flat file, statements and elements', [
  camt('deep.xml', '<a>'.repeat(100_000)),
  camt('deep64.xml', '<a>'.repeat(64) + '</a>'.repeat(64)),
  camt('deep65.xml', '<a>'.repeat(65) + '</a>'.repeat(65)),
  camt('many.xml', `<Document><X/>${'<Y/>'.repeat(200_000)}${d.stmt([d.ntry({ amt: '1.00' })])}</Document>`),
  camt('stmts.xml', d.doc(d.stmt([]).repeat(1001))),
  camt('stmts1000.xml', d.doc(d.stmt([]).repeat(1000))),
  camt('elements.xml', `<Document>${'<Y/>'.repeat(2_000_001)}</Document>`),
  camt('batch.xml', d.doc(d.stmt([d.ntry({ amt: '1.00', inner: `<NtryDtls>${'<TxDtls><RmtInf><Ustrd>x</Ustrd></RmtInf></TxDtls>'.repeat(3000)}</NtryDtls>` })]))),
  camt('big.xml', Buffer.alloc(20 * 1024 * 1024 + 1))
])
add('limits: 50,000 and 50,001 entries, 50,000 rows with the header', [
  camt('e50000.xml', d.doc(d.stmt(Array.from({ length: 50_000 }, () => d.ntry({ amt: '1.00' }))))),
  camt('e50001.xml', d.doc(d.stmt(Array.from({ length: 50_001 }, () => d.ntry({ amt: '1.00' }))))),
  camt('e49999.xml', d.doc(d.stmt(Array.from({ length: 49_999 }, () => d.ntry({ amt: '1.00' })))), 2)
])
add('limits: 50,000 CSV rows, 50,001 rows, 10 MB', [
  analyze('r50000.csv', 'Date,Amount\n' + '2026-01-01,-1.00\n'.repeat(49_999)),
  analyze('r50001.csv', 'Date,Amount\n' + '2026-01-01,-1.00\n'.repeat(50_000)),
  analyze('r50002.csv', 'Date,Amount\n' + '2026-01-01,-1.00\n'.repeat(50_001), 2),
  step('import.analyze', { fileName: 'tenmb.csv', contentBase64: d.b64(Buffer.concat([Buffer.from('Date,Amount\n2026-01-01,-1.00\n'), Buffer.alloc(10 * 1024 * 1024 - 28, 0x20)])), accountId: 3 }),
  step('import.analyze', { fileName: 'over.csv', contentBase64: d.b64(Buffer.concat([Buffer.from('Date,Amount\n2026-01-01,-1.00\n'), Buffer.alloc(10 * 1024 * 1024 - 27, 0x20)])), accountId: 3 })
])

// ----------------------------------------------------------------------------------------------------- the tests

describe('import scenarios: the app’s own dispatch against kb-core', () => {
  it('has at least 60 scenarios', () => expect(scenarios.length).toBeGreaterThanOrEqual(60))
  for (const [name, steps] of scenarios) {
    it(name, async () => {
      const scenario: Scenario = { name, steps }
      const outcome = await compare(scenario, false)
      // Guard against comparing two refusals only: most scenarios open an import that works.
      expect(outcome.results.length).toBe(steps.length)
    }, 600_000)
  }
})

describe('a seeded big file (50,000 rows)', () => {
  it('imports, finds the duplicates and undoes the same, with the time of each side', async () => {
    const file = d.bigFile(49_990, 20261114)
    const steps = [...SETUP, analyze('big.csv', file), commit(true), analyze('big.csv', file), step('import.batches'), step('import.undo', { batchId: 1 }), analyze('big2.csv', file), step('import.raw', { from: 49_000, count: 5 })]
    const outcome = await compare({ name: 'big csv', steps }, false)
    const data = (i: number): any => (outcome.results[i] as any).data
    const first = data(SETUP.length)
    expect(first.stats.total).toBe(49_990)
    expect(data(SETUP.length + 1).imported).toBeGreaterThan(40_000)
    expect(data(SETUP.length + 2).stats.duplicates).toBeGreaterThan(40_000)
    report(`[perf] 50k-row CSV, analyze + commit + analyze + undo + analyze: TypeScript ${Math.round(outcome.tsMs)} ms (with the harness), Rust ${Math.round(outcome.rustMs)} ms (kb-cli process, with its dump)`)
  }, 900_000)

  it('reads a big XML statement the same', async () => {
    const xml = d.bigXml(40_000, 20261114)
    const outcome = await compare({ name: 'big xml', steps: [...SETUP, camt('big.xml', xml), commit(true), camt('big.xml', xml)] }, false)
    expect((outcome.results[SETUP.length] as any).data.stats.total).toBe(40_000)
    report(`[perf] 40k-entry XML, analyze + commit + analyze: TypeScript ${Math.round(outcome.tsMs)} ms, Rust ${Math.round(outcome.rustMs)} ms`)
  }, 900_000)
})
