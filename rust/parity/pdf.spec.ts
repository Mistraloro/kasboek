// PDF parity: the TypeScript chain (pdf.js extractText -> toLines -> readStatement, src/core/pdf*) against the Rust crate kb-pdf
// (through its dev driver kb-pdf-cli) on invented PDFs. Three things are checked:
//  1. The logic port: the same PdfText (as pdf.js gave it) goes through toLines/readStatement/the assistant text selection on
//     both sides; lines, cells, statements, reconciliation and the text sent to the assistant must be identical.
//  2. The reader: the Rust reader and pdf.js give the same page sizes and error codes, and the statement read from the Rust
//     reader's text equals the statement read from pdf.js's text (cells and lines are compared too, with a tolerance on x).
//  3. Privacy: what is sent to the assistant, from the 3-page statement with a repeated header, is the same on both sides, holds
//     none of the top of the statement, and the preview is exactly the sent text.
// KB_TS_ROOT may point at a checkout whose src/ is the TypeScript to compare with (the release branch's linesToSend / laterPageLines).
// Needs: cargo build -p kb-pdf --features parity (KB_PDF_BIN overrides the path; the binary has required-features = ["parity"]).
// python3 with reportlab is optional: it adds the files of rust/parity/pdf/gen_py.py (embedded fonts, rotation, CID fonts).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectDecimal, headerField, scoreHeaderRow } from '@core/csv/mapping'
import { normHeader } from '@core/csv/read'
import { parseDate } from '@core/csv/normalize'
import { extractText } from '@core/pdf/extract'
import { toLines, type PdfLine, type PdfText } from '@core/pdf/lines'
import { linesToSend, pagesOf, partText, previewText, splitParts } from '@core/pdf-plan'
import { completeYear, isMonthName, readStatement, reconcile } from '@core/pdf/statement'
import { parseAmount } from '@shared/amount'
import { reconciliationBanner } from '@shared/pdf-import'
import { corpus, OTHER_IBAN, OWN_IBAN, type Sample } from './pdf/corpus'

const exe = process.platform === 'win32' ? '.exe' : ''
const candidates = ['release', 'debug'].map((p) => resolve(import.meta.dirname, `../target/${p}/kb-pdf-cli${exe}`))
const BIN = process.env.KB_PDF_BIN ?? candidates.find((c) => existsSync(c)) ?? candidates[0]!

const run = (args: string[], input?: string): string => execFileSync(BIN, args, { encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 })
const rustRead = (file: string): PdfText | { error: string } => JSON.parse(run(['read', file])) as PdfText | { error: string }
interface Logic {
  lines: PdfLine[]
  statement: ReturnType<typeof readStatement>
  analysis: { grid: string[][]; pdf: Record<string, unknown> }
  send: { preview?: Record<string, unknown>; parts?: string[]; error?: { code: string; message: string } }
}
const rustLogic = (text: PdfText, own: string | null): Logic => JSON.parse(run(own ? ['logic', own] : ['logic'], JSON.stringify(text))) as Logic

/** What src/main/assistant/pdf.ts `prepare` and `pdfAssistPreview` make of the lines, on the TypeScript side (release version: linesToSend). */
function tsSend(lines: PdfLine[]): Logic['send'] {
  if (!lines.length) return { error: { code: 'assistant.pdf_empty', message: 'This PDF has no text to read.' } }
  const masked = linesToSend(lines)
  if (!masked.length) return { error: { code: 'assistant.pdf_no_table', message: 'No transaction rows were found in this PDF, so nothing was sent.' } }
  const pages = pagesOf(masked)
  if (pages > 40) return { error: { code: 'assistant.pdf_too_long', message: `This statement has ${pages} pages with text. The assistant reads at most 40 pages; try a shorter period.` } }
  const text = previewText(masked)
  const parts = splitParts(masked)
  return { preview: { pages, parts: parts.length, chars: text.length, approxTokens: Math.ceil(text.length / 3), text }, parts: parts.map(partText) }
}

const isError = (r: unknown): r is { error: string } => typeof r === 'object' && r !== null && 'error' in r

// ---------------------------------------------------------------------------------------- corpus

const work = mkdtempSync(join(tmpdir(), 'kb-pdf-parity-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** reportlab and hand-written PDFs of gen_py.py, when python3 with reportlab is there. */
function pythonSamples(): Sample[] {
  const dir = join(work, 'py')
  mkdirSync(dir)
  const r = spawnSync('python3', ['-I', join(import.meta.dirname, 'pdf/gen_py.py'), dir], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pdf'))
    .sort()
    .map((f) => ({ name: `py_${f.slice(0, -4)}`, bytes: new Uint8Array(readFileSync(join(dir, f))), own: null }))
}

/** Differences between pdf.js and the Rust reader that are known and explained (docs/rust-port-plan.md, section 10, M2 slice 3b). */
const KNOWN_DIFFERENT_CELLS = new Set<string>([
  // Courier: a space is 0.6 em wide, exactly pdf.js's limit for "space in the flow"; pdf.js lands on either side by rounding.
  'py_rl_courier',
  // A font that is not embedded and has /Widths unlike the substitute font (all 600 here): hayro stretches each glyph to the PDF's width,
  // so the width that the glyph transform gives is not the font size times the advance, and a word is cut. Real Arial or Times New
  // Roman have the metrics of their substitutes, so the stretch is 1 and this does not show.
  'py_raw_differences'
])

/** Files where pdf.js gives garbled text (a CID font without ToUnicode: the glyph numbers as characters) and the Rust reader recovers it
 * from the font program: the text must equal the one pdf.js reads from the same table with a ToUnicode map. */
const REPAIRED: Record<string, string> = { py_raw_cid_no_tounicode: 'py_raw_cid_identityH' }

interface Case extends Sample {
  file: string
}
const cases: Case[] = [...corpus(), ...pythonSamples()].map((s) => {
  const file = join(work, `${s.name}.pdf`)
  writeFileSync(file, s.bytes)
  return { ...s, file }
})

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

describe('kb-pdf against the TypeScript PDF chain', () => {
  it('has the corpus (at least 40 invented PDFs)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s: logic port, reader and statement', async (_name, c) => {
    let ref: PdfText | { error: string }
    try {
      ref = await extractText(c.bytes)
    } catch (e) {
      ref = { error: (e as { code?: string }).code ?? 'error' }
    }
    const rust = rustRead(c.file)
    // Same answer class and, for errors, the same code (pdf.js reads a few files the Rust reader calls scanned: listed below).
    if (isError(ref) || isError(rust)) {
      expect(isError(rust) ? rust.error : 'ok', c.name).toBe(isError(ref) ? ref.error : 'ok')
      return
    }
    expect(rust.pageCount, c.name).toBe(ref.pageCount)
    rust.pages.forEach((p, k) => {
      expect(p.width).toBeCloseTo(ref.pages[k]!.width, 0)
      expect(p.height).toBeCloseTo(ref.pages[k]!.height, 0)
    })

    // 1. The logic port, on pdf.js's own text.
    const own = c.own ?? null
    const lines = toLines(ref)
    const statement = readStatement(lines, own)
    const logic = rustLogic(ref, own)
    expect(logic.lines, `${c.name}: lines`).toEqual(JSON.parse(JSON.stringify(lines)))
    expect(logic.statement, `${c.name}: statement`).toEqual(JSON.parse(JSON.stringify(statement)))
    expect(logic.send, `${c.name}: text for the assistant`).toEqual(JSON.parse(JSON.stringify(tsSend(lines))))

    // 2. The reader: the Rust reader's text through the Rust logic equals pdf.js's text through the TypeScript logic.
    const viaRust = rustLogic(rust, own)
    const repairedFrom = REPAIRED[c.name]
    if (repairedFrom) {
      const good = await extractText(cases.find((x) => x.name === repairedFrom)!.bytes)
      expect(viaRust.lines.map((l) => l.cells.map((x) => norm(x.text))), `${c.name}: cells`).toEqual(toLines(good).map((l) => l.cells.map((x) => norm(x.text))))
      expect(viaRust.statement, `${c.name}: statement`).toEqual(JSON.parse(JSON.stringify(readStatement(toLines(good), own))))
      return
    }
    if (!KNOWN_DIFFERENT_CELLS.has(c.name)) {
      expect(viaRust.lines.map((l) => l.cells.map((x) => norm(x.text))), `${c.name}: cells`).toEqual(lines.map((l) => l.cells.map((x) => norm(x.text))))
    }
    expect(viaRust.statement, `${c.name}: statement from the Rust reader`).toEqual(JSON.parse(JSON.stringify(statement)))
  })

  it('reconciliation and the flip hint equal the TypeScript for the grids read', async () => {
    for (const c of cases) {
      const ref = await extractText(c.bytes).catch(() => null)
      if (!ref) continue
      const st = readStatement(toLines(ref), c.own ?? null)
      if (st.grid.length < 2) continue
      // Amounts of a grid as the import would read them: the "Amount" or "Balance" column as plain cents where the text allows.
      const cents = (t: string | undefined): number | null => {
        const m = /^(-)?(\d[\d.,' ]*)[.,](\d{2})$/.exec((t ?? '').trim())
        return m ? (m[1] ? -1 : 1) * Number(m[2]!.replace(/[^\d]/g, '') + m[3]) : null
      }
      const rows = st.grid.slice(1).map((r) => ({ amountCents: cents(r[2]), balanceCents: cents(r.at(-1)) }))
      const input = { rows, balances: st.balances }
      const rs = JSON.parse(run(['reconcile'], JSON.stringify(input))) as { reconciliation: unknown; banner: unknown }
      const r = reconcile(rows, st.balances)
      expect(rs.reconciliation, c.name).toEqual(JSON.parse(JSON.stringify(r)))
      expect(rs.banner, c.name).toEqual(JSON.parse(JSON.stringify(reconciliationBanner(r))))
    }
  })

  it('the flip hint: a card statement whose rows go the wrong way round', () => {
    const rows = [{ amountCents: 5000, balanceCents: null }, { amountCents: 2500, balanceCents: null }]
    const balances = { opening: 50000, closing: 42500 }
    const rs = JSON.parse(run(['reconcile'], JSON.stringify({ rows, balances }))) as { banner: unknown }
    expect(rs.banner).toEqual({ kind: 'maybeFlip', differenceCents: -15000 })
    expect(rs.banner).toEqual(JSON.parse(JSON.stringify(reconciliationBanner(reconcile(rows, balances)))))
  })
})

// ------------------------------------------------------------------------------------- fixtures

// Known answers for the Rust unit tests (rust/crates/kb-pdf/tests/ts_parity.rs): pdf.js's text of some invented statements with the
// TypeScript's lines, statement and assistant text. Committed; regenerate only when the logic changes on purpose:
//   KB_WRITE_FIXTURES=1 npx vitest run --config rust/parity/vitest.config.ts rust/parity/pdf.spec.ts -t "write fixtures"
const FIXTURE_NAMES = [
  'ts_statement', 'ts_blocks', 'ts_turned3', 'nl_table_saldo', 'fr_debit_credit', 'de_buchungstag', 'uk_card_flip', 'en_dr_cr', 'yearless_period',
  'yearless_year_above', 'yearless_nothing', 'named_dates', 'december_january', 'carry_forward', 'other_account_note', 'iban_in_description',
  'continuation_lines', 'brackets', 'us_mdy', 'three_pages_repeat_header', 'free_text_no_table'
]
describe.runIf(process.env.KB_WRITE_FIXTURES === '1')('write fixtures', () => {
  it('writes logic.json', async () => {
    const out = []
    for (const name of FIXTURE_NAMES) {
      const c = cases.find((x) => x.name === name)!
      const text = await extractText(c.bytes)
      const lines = toLines(text)
      out.push({ name, own: c.own ?? null, text, lines, statement: readStatement(lines, c.own ?? null), send: tsSend(lines) })
    }
    writeFileSync(resolve(import.meta.dirname, '../crates/kb-pdf/tests/fixtures/logic.json'), JSON.stringify(out) + '\n')
  })

  it('writes csvrules.json', () => {
    const dates = [
      '03/11/2026', '3.11.26', '2026-11-03', '20261103', '11/03/2026', '31/02/2026', '29/02/2028', '29/02/2027', '1 Nov 2026', '16-nov-26', 'Nov 16, 2026',
      '16. November 2026', '3 mars 2026', '17 janvier 2026', 'jänner 2026 3', 'Jänner 3 2026', '15 mei 2026', '5 sept. 2026', '5 sep 2026 10:00', '2026-11-03T10:20:30',
      '2026-11-03 10:20', '03/11/1989', '03/11/2101', '03/11/90', '00/00/00', '', 'abc', '12', '1/2', '1-2-3', '03/13/2026', '13/13/2026', '3 xyz 2026', '99999999',
      '1/2/3/4', '3 november', 'dec 2026 5', '1 Nov 2026 99', '  03/11/2026  ', '03-11-2026', '2026/11/03'
    ]
    const amounts = [
      '12,50', '-1.234,56', '1 234,56', '+12.00', '12,50-', '€ 3,20', '(4,00)', 'USD 12.50', '12.50 DR', '12.50 CR', '1,234.56', "1'234.56", '12', '12.5', '12.345', '1.234',
      '1,234', '-', '', 'abc', '12.50-', '--5', '(12,50)-', 'R$ 9,90', 'kr 100', '100 kr', '12,50 CHF', 'EUR 12,50', '12,50EUR', '0,00', '-0,00', '1.000.000,00',
      '1,000,000.00', '9007199254740993', '90071992547409,93', '12,505', '12,500', '+1.5', ' 7,25 ', '€12,50', '£ 1,000.00 CR', '1 000', '12.50.', '(', '()', 'CR 12.50'
    ]
    const decimalSamples = [['12,50', '1.234,56'], ['12.50', '1,234.56'], ['12.50 DR', '(4.00)'], ['5,5-', '1.0-'], [], ['abc'], ['1,50', '2.50', '3.50']]
    const headers = [
      'Datum', 'Date', 'Booking date', 'Boekingsdatum', 'Omschrijving', 'Description', 'Bedrag', 'Amount', 'Debit', 'Credit', 'Balance', 'Saldo', 'Valuta', 'Value date',
      'Buchungstag', 'Wertstellung', 'Verwendungszweck', 'Betrag', 'Soll', 'Haben', 'Libellé', 'Débit', 'Crédit', 'Solde', 'Fecha', 'Importe', 'Concepto', 'Data', 'Importo',
      'Iban', 'Naam tegenpartij', 'Transaction type', 'Mededeling', 'Reference', 'Währung', "Today's date", 'Opening balance', 'x', '', 'Date de valeur', 'Details of payment',
      'Account number', 'Value  Date', 'DATE', 'datum boeking'
    ]
    const periods: [string, { from: string | null; to: string | null }][] = [
      ['03/11', { from: null, to: '2026-11-30' }], ['03 NOV', { from: '2026-11-01', to: '2026-11-30' }], ['15/12', { from: '2026-12-15', to: '2027-01-14' }], ['02/01', { from: '2026-12-15', to: '2027-01-14' }],
      ['03/11', { from: '2026-11-01', to: null }], ['03/10', { from: '2026-11-01', to: null }], ['Nov 3', { from: null, to: '2026-11-30' }], ['03.11.', { from: null, to: '2026-03-01' }],
      ['03/11/2026', { from: null, to: '2026-11-30' }], ['abc', { from: null, to: '2026-11-30' }], ['3/11', { from: null, to: null }], ['31/02', { from: null, to: '2026-11-30' }]
    ]
    const months = ['NOV', 'Nov.', 'november', 'mars', 'Jänner', 'xyz', 'ab', 'Januar', 'dec', 'DEZ', 'mei', 'Sept', 'Sep.']
    const out = {
      dates: dates.flatMap((input) => (['DMY', 'MDY', 'YMD'] as const).map((order) => ({ input, order, result: parseDate(input, order) }))),
      amounts: amounts.flatMap((input) => [',', '.'].map((decimal) => ({ input, decimal, result: parseAmount(input, decimal as ',' | '.') }))),
      decimals: decimalSamples.map((samples) => ({ samples, result: detectDecimal(samples) })),
      headers: headers.map((input) => ({ input, norm: normHeader(input), field: headerField(input), score: scoreHeaderRow([input, input]) })),
      years: periods.map(([input, period]) => ({ input, period, result: completeYear(input, period) })),
      months: months.map((input) => ({ input, result: isMonthName(input) }))
    }
    writeFileSync(resolve(import.meta.dirname, '../crates/kb-pdf/tests/fixtures/csvrules.json'), JSON.stringify(out) + '\n')
  })
})

// ------------------------------------------------------------------------- fonts without ToUnicode

describe('fonts without a ToUnicode map', () => {
  const dir = join(work, 'cid')
  const made = (() => {
    mkdirSync(dir, { recursive: true })
    return spawnSync('python3', ['-I', join(import.meta.dirname, 'pdf/gen_cid_matrix.py'), dir], { encoding: 'utf8' }).status === 0
  })()
  const cells = (t: PdfText): string[][] => toLines(t).map((l) => l.cells.map((c) => norm(c.text)))

  it.skipIf(!made)('recovers the text from the font program where there is a cmap or glyph names, and calls the rest a scan', async () => {
    const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8')) as { reference: string; recoverable: string[]; unrecoverable: string[]; partial: string[] }
    const ref = rustRead(join(dir, `${truth.reference}.pdf`)) as PdfText
    expect(cells(ref).length).toBeGreaterThan(4)
    // The reference (with ToUnicode) is read the same by pdf.js and by Rust.
    expect(cells(await extractText(new Uint8Array(readFileSync(join(dir, `${truth.reference}.pdf`)))))).toEqual(cells(ref))
    for (const name of truth.recoverable) expect(cells(rustRead(join(dir, `${name}.pdf`)) as PdfText), name).toEqual(cells(ref))
    // Partly: every line without accents is right (codes above 127 of a symbolic simple font are read by hayro's default encoding).
    for (const name of truth.partial) {
      const got = cells(rustRead(join(dir, `${name}.pdf`)) as PdfText)
      expect(got.length, name).toBe(cells(ref).length)
      cells(ref).forEach((row, i) => (row.some((x) => /Caf/.test(x)) ? expect(got[i]).not.toEqual(row) : expect(got[i], name).toEqual(row)))
    }
    for (const name of truth.unrecoverable) expect(rustRead(join(dir, `${name}.pdf`)), name).toEqual({ error: 'import.pdf_scanned' })
  })
})

// -------------------------------------------------------------------------------------- privacy

const CARD = '4929123456789012'
const line = (id: number, page: number, cells: [number, string][]): PdfLine => ({ id, page, y: 800 - id * 12, pageHeight: 842, cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 })) })

/** A statement: header lines (name, address, account), the table header, then `pages` pages of two payments each (tests/pdf-assist.test.ts). */
function statementLines(pages: number): PdfLine[] {
  const lines: PdfLine[] = [
    line(0, 1, [[40, 'Jan Jansen']]),
    line(1, 1, [[40, 'Main Street 1, Springfield']]),
    line(2, 1, [[40, `Account ${OWN_IBAN}`]]),
    line(3, 1, [[60, 'Date'], [140, 'Description'], [400, 'Amount'], [510, 'Balance']])
  ]
  for (let p = 1; p <= pages; p++) {
    const day = String(p).padStart(2, '0')
    lines.push(line(lines.length, p, [[60, `${day}/11`], [140, `SHOP ${p} card ${CARD}`], [400, `${p},50-`], [510, '100,00']]))
    lines.push(line(lines.length, p, [[140, `Transfer to Jan Peeters ${OTHER_IBAN}`]]))
    lines.push(line(lines.length, p, [[60, `${day}/11`], [140, `PAYMENT ${p}`], [400, `${p},25`], [510, '100,00']]))
  }
  return lines
}
const rustSend = (lines: PdfLine[]): Logic['send'] => JSON.parse(run(['send'], JSON.stringify(lines))) as Logic['send']
const same = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

describe('what is sent to the assistant', () => {
  it.each([1, 2, 3, 5, 9])('equals the TypeScript on the %i-page statement with a header', (pages) => {
    const lines = statementLines(pages)
    expect(rustSend(lines)).toEqual(same(tsSend(lines)))
  })

  it('without the table header, equals the TypeScript (the first date and amount line, or nothing)', () => {
    const noHeader = statementLines(3).filter((l) => l.id !== 3)
    expect(rustSend(noHeader)).toEqual(same(tsSend(noHeader)))
    const top = [line(0, 1, [[40, 'Jan Jansen']]), line(1, 1, [[40, 'Main Street 1']]), line(2, 2, [[60, '01/11'], [140, 'X'], [400, '1,00-']])]
    expect(rustSend(top)).toEqual(same(tsSend(top)))
    const words = Array.from({ length: 12 }, (_, i) => line(i, 1, [[40, `Words ${i}`]]))
    expect(rustSend(words)).toEqual(same(tsSend(words)))
    expect(rustSend([])).toEqual(same(tsSend([])))
  })

  it('leaves out the top of the statement and masks numbers; the preview is the sent text', () => {
    const lines = statementLines(3)
    const s = rustSend(lines)
    const preview = s.preview as { text: string; chars: number; pages: number; parts: number }
    expect(preview).toMatchObject({ pages: 3, parts: 1 })
    expect(preview.chars).toBe(preview.text.length)
    expect(preview.text).not.toMatch(/Jansen|Main Street|Account|Springfield/)
    expect(preview.text).not.toContain(OWN_IBAN)
    expect(preview.text).toContain('x140 Transfer to Jan Peeters BE…6769')
    expect(preview.text).toContain('card …9012')
    expect(preview.text).not.toContain(CARD)
    expect(s.parts![0]!.split('\n').slice(2).join('\n')).toBe(preview.text)
  })

  it('sends only table rows: a holder name and address repeated on later pages are not sent, a later page without a transaction is dropped', () => {
    const head: [number, string][] = [[60, 'Date'], [140, 'Description'], [510, 'Amount']]
    const lines = [
      line(0, 1, [[40, 'Ilse Vermeulen']]), line(1, 1, [[40, 'Kerkstraat 12, 8000 Gent']]), line(2, 1, head),
      line(3, 1, [[60, '03/11'], [140, 'ALBERT HEIJN'], [510, '45,10-']]), line(4, 1, [[140, 'continued on next page']]),
      line(5, 2, [[40, 'Ilse Vermeulen']]), line(6, 2, [[40, 'Kerkstraat 12, 8000 Gent']]), line(7, 2, [[40, 'Customer 4455667']]), line(8, 2, head),
      line(9, 2, [[60, '05/11'], [140, 'SALARY NOVEMBER'], [510, '2.000,00']]),
      line(10, 3, [[40, 'Ilse Vermeulen']]), line(11, 3, [[60, '07/11'], [140, 'TRAM TICKET'], [510, '2,40-']]), line(12, 3, [[140, 'Thank you']]),
      line(13, 4, [[40, 'Ilse Vermeulen']]), line(14, 4, [[40, 'Kerkstraat 12']])
    ]
    const s = rustSend(lines)
    expect(s).toEqual(same(tsSend(lines)))
    const text = (s.preview as { text: string }).text
    expect(text).not.toMatch(/Ilse|Vermeulen|Kerkstraat|Gent|Customer|4455667/)
    expect(text).toMatch(/ALBERT HEIJN[\s\S]*SALARY NOVEMBER[\s\S]*TRAM TICKET/)
    expect(text.split('\n').map((l) => l.split(' ')[0])).toEqual(['L2', 'L3', 'L4', 'L9', 'L11', 'L12'])
  })

  it('refuses more than 40 pages and a statement with no lines', () => {
    expect(rustSend(statementLines(41)).error?.code).toBe('assistant.pdf_too_long')
    expect(rustSend([]).error?.code).toBe('assistant.pdf_empty')
    expect(rustSend([line(0, 1, [[40, 'Only a name']])]).error?.code).toBe('assistant.pdf_no_table')
  })

  it('the repeated-header statement read from a real PDF: only table rows are sent, equal to the TypeScript', async () => {
    const c = cases.find((x) => x.name === 'three_pages_repeat_header')!
    const lines = toLines(await extractText(c.bytes))
    const ts = tsSend(lines)
    expect(rustSend(lines)).toEqual(same(ts))
    const text = (ts.preview as { text: string }).text
    expect(text).not.toMatch(/Jan Jansen|Hoofdstraat|Account BE68|Voorbeeldbank/)
    expect(text).toContain('Bakkerij Zon 1')
  })
})
