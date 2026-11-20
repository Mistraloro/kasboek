// The invented statements of the PDF parity suite (rust/parity/pdf.spec.ts), built with the repo's own PDF helper
// (tests/helpers/make-pdf.ts). Every name, number and amount here is made up; IBANs are example numbers with valid check digits.
import { makePdf, type PdfOptions, type PdfPageSpec } from '../../../tests/helpers/make-pdf'
import { STATEMENT_PAGES } from '../../../tests/helpers/statement-pdf'
import { blockPages, turnedPages, TXS } from './layouts'

export const OWN_IBAN = 'BE68539007547034'
export const OTHER_IBAN = 'BE71096123456769'
const OWN_SPACED = 'BE68 5390 0754 7034'

export interface Sample {
  name: string
  bytes: Uint8Array
  /** The account number the statement is read for (null: none given). */
  own?: string | null
}

type Piece = NonNullable<PdfPageSpec['texts']>[number]

interface Layout {
  name: string
  /** Lines above the table: one cell each, or several cells at the column positions. */
  preface: string[][]
  header: string[]
  rows: string[][]
  /** x of each column. */
  xs: number[]
  /** Rows per page. */
  per?: number
  /** Lines under the table of the last page (closing balance and so on). */
  after?: string[][]
  /** Lines at the top and bottom of every page. */
  margins?: (page: number, pages: number) => { top?: string[]; bottom?: string[] }
  /** Repeat the header on every page after the first. */
  repeatHeader?: boolean
  size?: number
  width?: number
  height?: number
  rotate?: PdfPageSpec['rotate']
  own?: string | null
  flate?: boolean
  /** Lines between the rows (continuation text) by row index. */
  extra?: Record<number, string[][]>
}

const STEP = 14

function build(l: Layout): Sample {
  const per = l.per ?? 12
  const size = l.size ?? 9
  const height = l.height ?? 842
  const pages: PdfPageSpec[] = []
  const pageCount = Math.max(1, Math.ceil(l.rows.length / per))
  const put = (texts: Piece[], cells: string[], y: number, xs = l.xs): void => cells.forEach((c, i) => c && texts.push({ x: xs[i] ?? xs.at(-1)!, y, text: c, size }))
  for (let p = 0; p < pageCount; p++) {
    const texts: Piece[] = []
    const m = l.margins?.(p + 1, pageCount)
    if (m?.top) put(texts, m.top, height - 30)
    if (m?.bottom) put(texts, m.bottom, 30)
    let y = height - 70
    if (p === 0) {
      for (const line of l.preface) {
        put(texts, line, y)
        y -= STEP
      }
      y -= 6
    }
    if (p === 0 || l.repeatHeader) {
      put(texts, l.header, y)
      y -= STEP
    }
    l.rows.slice(p * per, (p + 1) * per).forEach((row, i) => {
      put(texts, row, y)
      y -= STEP
      for (const extra of l.extra?.[p * per + i] ?? []) {
        put(texts, extra, y)
        y -= STEP
      }
    })
    if (p === pageCount - 1) for (const line of l.after ?? []) (put(texts, line, y), (y -= STEP))
    pages.push({ texts, width: l.width, height: l.height, rotate: l.rotate })
  }
  const opts: PdfOptions = { flate: l.flate }
  return { name: l.name, bytes: makePdf(pages, opts), own: l.own === undefined ? OWN_IBAN : l.own }
}

const eu = (cents: number, dec = ',', thou = '.'): string => {
  const [w, f] = (Math.abs(cents) / 100).toFixed(2).split('.')
  return `${cents < 0 ? '-' : ''}${w!.replace(/\B(?=(\d{3})+(?!\d))/g, thou)}${dec}${f}`
}

/** n invented transactions: description, signed cents. */
const TX = (n: number, from = 0): { d: string; c: number; day: number }[] =>
  Array.from({ length: n }, (_, i) => {
    const k = i + from
    const c = (k % 5 === 4 ? 1 : -1) * (1250 + ((k * 7919) % 90000))
    return { d: ['Bakkerij Zon', 'Energie Test BV', 'Winkel Noord', 'Salaris november', 'Tramkaart Stad', 'Boekhandel Hoek', 'Apotheek Lente'][k % 7]! + ` ${k + 1}`, c, day: 1 + (k % 28) }
  })

function runBalance(rows: { c: number }[], open: number): number[] {
  let b = open
  return rows.map((r) => (b += r.c))
}

const dmy = (day: number, m = 11, y = 2026, sep = '/'): string => [String(day).padStart(2, '0'), String(m).padStart(2, '0'), y].join(sep)

function layouts(): Layout[] {
  const out: Layout[] = []
  // Dutch table with saldo
  {
    const t = TX(14)
    const bal = runBalance(t, 100000)
    out.push({
      name: 'nl_table_saldo',
      preface: [['Rekeningafschrift'], [`Rekening ${OWN_SPACED}`], ['Periode 01-11-2026 tot 30-11-2026'], ['Beginsaldo', '', '', eu(100000)], ['Eindsaldo', '', '', eu(bal.at(-1)!)]],
      header: ['Datum', 'Omschrijving', 'Bedrag', 'Saldo'],
      rows: t.map((x, i) => [dmy(x.day, 11, 2026, '-'), x.d, eu(x.c), eu(bal[i]!)]),
      xs: [40, 110, 330, 430]
    })
  }
  // French table, accents, debit/credit
  {
    const t = TX(10)
    const bal = runBalance(t, 250000)
    out.push({
      name: 'fr_debit_credit',
      preface: [['Relevé de compte'], [`IBAN ${OWN_IBAN}`], ['Période du 01/11/2026 au 30/11/2026'], ['Solde précédent', '', '', '', eu(250000, ',', ' ')]],
      header: ['Date', 'Libellé', 'Débit', 'Crédit', 'Solde'],
      rows: t.map((x, i) => [dmy(x.day), x.d + ' é', x.c < 0 ? eu(-x.c, ',', ' ') : '', x.c > 0 ? eu(x.c, ',', ' ') : '', eu(bal[i]!, ',', ' ')]),
      xs: [40, 100, 300, 380, 460],
      after: [['Nouveau solde', '', '', '', eu(bal.at(-1)!, ',', ' ')]]
    })
  }
  // German, dd.mm.yyyy, Verwendungszweck
  {
    const t = TX(11)
    const bal = runBalance(t, 5000)
    out.push({
      name: 'de_buchungstag',
      preface: [['Kontoauszug'], [`IBAN ${OWN_SPACED}`], ['Zeitraum 01.11.2026 bis 30.11.2026'], ['Alter Kontostand', eu(5000)]],
      header: ['Buchungstag', 'Wertstellung', 'Verwendungszweck', 'Betrag'],
      rows: t.map((x) => [dmy(x.day, 11, 2026, '.'), dmy(x.day, 11, 2026, '.'), x.d, eu(x.c)]),
      xs: [40, 120, 200, 450],
      after: [['Neuer Kontostand', eu(bal.at(-1)!)]]
    })
  }
  // Credit card statement: purchases positive, so the rows go the wrong way round (banner maybeFlip)
  {
    const t = TX(9).map((x) => ({ ...x, c: Math.abs(x.c) }))
    out.push({
      name: 'uk_card_flip',
      preface: [['Credit card statement'], [`Account ${OWN_IBAN}`], ['Statement period 01/11/2026 to 30/11/2026'], ['Previous balance', '', '500.00'], ['New balance', '', eu(500 * 100 + t.reduce((n, x) => n + x.c, 0), '.', ',')]],
      header: ['Date', 'Description', 'Amount'],
      rows: t.map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
      xs: [40, 110, 400]
    })
  }
  // DR / CR suffixes
  {
    const t = TX(10)
    out.push({
      name: 'en_dr_cr',
      preface: [['Statement of account'], [`Account ${OWN_IBAN}`], ['Statement from 01/11/2026 to 30/11/2026']],
      header: ['Date', 'Description', 'Amount', 'Balance'],
      rows: t.map((x, i) => [dmy(x.day), x.d, `${eu(Math.abs(x.c), '.', ',')} ${x.c < 0 ? 'DR' : 'CR'}`, `${eu(1000000 + i * 100, '.', ',')} CR`]),
      xs: [40, 110, 330, 430]
    })
  }
  // Dates without a year, period printed
  {
    const t = TX(9)
    out.push({
      name: 'yearless_period',
      preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
      header: ['Date', 'Description', 'Amount'],
      rows: t.map((x) => [`${String(x.day).padStart(2, '0')}/11`, x.d, eu(x.c, '.', ',')]),
      xs: [40, 110, 400]
    })
  }
  // Dates without a year and no period: the year printed above stands for it
  {
    const t = TX(8)
    out.push({
      name: 'yearless_year_above',
      preface: [['Statement printed 17 November 2026'], ['Account overview 2026']],
      header: ['Date', 'Description', 'Amount'],
      rows: t.map((x) => [`${String(x.day).padStart(2, '0')}.11.`, x.d, eu(x.c)]),
      xs: [40, 110, 400]
    })
  }
  // Dates without a year and no year anywhere: a note
  out.push({
    name: 'yearless_nothing',
    preface: [['Statement']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(6).map((x) => [`${String(x.day).padStart(2, '0')}/11`, x.d, eu(x.c)]),
    xs: [40, 110, 400]
  })
  // Named dates: 03 NOV
  out.push({
    name: 'named_dates',
    preface: [['Statement'], ['From 01 Nov 2026 to 30 Nov 2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [`${String(x.day).padStart(2, '0')} NOV`, x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  // December to January statement with yearless dates
  out.push({
    name: 'december_january',
    preface: [['Statement'], ['Period 15/12/2026 to 14/01/2027']],
    header: ['Date', 'Description', 'Amount'],
    rows: [...TX(4).map((x) => [`${String(15 + x.day % 15).padStart(2, '0')}/12`, x.d, eu(x.c, '.', ',')]), ...TX(4, 4).map((x) => [`${String(1 + x.day % 13).padStart(2, '0')}/01`, x.d, eu(x.c, '.', ',')])],
    xs: [40, 110, 400]
  })
  // Several pages with a repeated header, carry-forward lines and page margins
  {
    const t = TX(30)
    const bal = runBalance(t, 100000)
    out.push({
      name: 'three_pages_repeat_header',
      preface: [['Jan Jansen'], ['Hoofdstraat 1, Voorbeeldstad'], [`Account ${OWN_IBAN}`], ['Statement 01/11/2026 to 30/11/2026'], ['Opening balance', '', '', eu(100000, '.', ',')]],
      header: ['Date', 'Description', 'Amount', 'Balance'],
      rows: t.map((x, i) => [dmy(x.day), x.d, eu(x.c, '.', ','), eu(bal[i]!, '.', ',')]),
      xs: [40, 110, 330, 430],
      per: 10,
      repeatHeader: true,
      margins: (p, n) => ({ top: ['Voorbeeldbank NV', '', `Statement of Jan Jansen`], bottom: [`Page ${p} of ${n}`, '', 'Printed 17/11/2026'] }),
      after: [['Closing balance', '', '', eu(bal.at(-1)!, '.', ',')]]
    })
  }
  // Brought forward / carried forward
  {
    const t = TX(20)
    const bal = runBalance(t, 100000)
    const rows: string[][] = []
    t.forEach((x, i) => {
      if (i % 10 === 0 && i > 0) rows.push(['', 'Balance carried forward', '', eu(bal[i - 1]!, '.', ',')], ['', 'Balance brought forward', '', eu(bal[i - 1]!, '.', ',')])
      rows.push([dmy(x.day), x.d, eu(x.c, '.', ','), eu(bal[i]!, '.', ',')])
    })
    out.push({
      name: 'carry_forward',
      preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026'], ['Opening balance', '', '', eu(100000, '.', ',')]],
      header: ['Date', 'Description', 'Amount', 'Balance'],
      rows,
      xs: [40, 110, 330, 430],
      per: 12,
      repeatHeader: true
    })
  }
  // Another account's number printed: a note
  out.push({
    name: 'other_account_note',
    preface: [['Statement'], [`Account ${OTHER_IBAN}`], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(7).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  out.push({
    name: 'no_own_iban',
    preface: [['Statement'], [`Account ${OTHER_IBAN}`], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(7).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400],
    own: null
  })
  // A counterparty IBAN inside the description gets an IBAN column
  out.push({
    name: 'iban_in_description',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(7).map((x, i) => [dmy(x.day), i % 2 ? `${x.d} ${OTHER_IBAN}` : x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  // Continuation lines of a description
  {
    const t = TX(8)
    out.push({
      name: 'continuation_lines',
      preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
      header: ['Date', 'Description', 'Amount'],
      rows: t.map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
      xs: [40, 110, 400],
      extra: { 1: [['', 'Reference 12345 Voorbeeld']], 3: [['', 'Second line'], ['', 'Third line']], 5: [['', 'Another note']] }
    })
  }
  // Currency forms and sign styles
  out.push({
    name: 'currency_prefix',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x, i) => [dmy(x.day), x.d, `${['EUR ', '€ ', '$', 'GBP '][i % 4]}${eu(x.c, '.', ',')}`]),
    xs: [40, 110, 400]
  })
  out.push({
    name: 'trailing_minus',
    preface: [['Rekeningafschrift'], ['Periode 01-11-2026 tot 30-11-2026']],
    header: ['Datum', 'Omschrijving', 'Bedrag'],
    rows: TX(8).map((x) => [dmy(x.day, 11, 2026, '-'), x.d, x.c < 0 ? `${eu(-x.c)}-` : eu(x.c)]),
    xs: [40, 110, 400]
  })
  out.push({
    name: 'brackets',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Details', 'Amount'],
    rows: TX(8).map((x) => [dmy(x.day), x.d, x.c < 0 ? `(${eu(-x.c, '.', ',')})` : eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  out.push({
    name: 'thousands_apostrophe',
    preface: [['Kontoauszug'], ['Zeitraum 01.11.2026 bis 30.11.2026'], ['Anfangssaldo', '', "1'000.00"]],
    header: ['Datum', 'Text', 'Betrag', 'Saldo'],
    rows: TX(8).map((x, i) => [dmy(x.day, 11, 2026, '.'), x.d, `${x.c < 0 ? '-' : ''}${(Math.abs(x.c) / 100).toFixed(2)}`, `${1000 + i}'123.45`]),
    xs: [40, 110, 330, 430]
  })
  out.push({
    name: 'space_thousands',
    preface: [['Relevé'], ['Période du 01/11/2026 au 30/11/2026']],
    header: ['Date', 'Opération', 'Montant'],
    rows: TX(8).map((x) => [dmy(x.day), x.d, eu(x.c * 3, ',', ' ')]),
    xs: [40, 110, 400]
  })
  // US order, ISO dates
  out.push({
    name: 'us_mdy',
    preface: [['Account activity'], ['From 11/01/2026 to 11/30/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [`11/${String(x.day).padStart(2, '0')}/2026`, x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  out.push({
    name: 'iso_dates',
    preface: [['Statement'], ['Period 2026-11-01 to 2026-11-30']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [`2026-11-${String(x.day).padStart(2, '0')}`, x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400]
  })
  // Spanish and Italian headers
  out.push({
    name: 'es_fecha_importe',
    preface: [['Extracto'], ['Del 01/11/2026 al 30/11/2026'], ['Saldo anterior', '', eu(300000)]],
    header: ['Fecha', 'Concepto', 'Importe', 'Saldo'],
    rows: TX(9).map((x, i) => [dmy(x.day), x.d, eu(x.c), eu(300000 + i * 1000)]),
    xs: [40, 110, 330, 430]
  })
  out.push({
    name: 'it_data_importo',
    preface: [['Estratto conto'], ['Periodo 01/11/2026 - 30/11/2026']],
    header: ['Data', 'Descrizione', 'Importo'],
    rows: TX(9).map((x) => [dmy(x.day), x.d, eu(x.c)]),
    xs: [40, 110, 400]
  })
  // Other sizes and page formats
  out.push({
    name: 'landscape_a4',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount', 'Balance'],
    rows: TX(16).map((x, i) => [dmy(x.day), x.d, eu(x.c, '.', ','), eu(100000 + i, '.', ',')]),
    xs: [40, 140, 500, 640],
    width: 842,
    height: 595,
    per: 12
  })
  out.push({
    name: 'small_font_7',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(12).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400],
    size: 7
  })
  out.push({
    name: 'large_font_12_flate',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(10).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 130, 420],
    size: 12,
    flate: true
  })
  out.push({
    name: 'rotate_90_table',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400],
    rotate: 90
  })
  out.push({
    name: 'rotate_180_table',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400],
    rotate: 180
  })
  out.push({
    name: 'rotate_270_table',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [dmy(x.day), x.d, eu(x.c, '.', ',')]),
    xs: [40, 110, 400],
    rotate: 270
  })
  // Value date column
  out.push({
    name: 'value_date',
    preface: [['Statement'], ['Period 01/11/2026 to 30/11/2026']],
    header: ['Booking date', 'Value date', 'Description', 'Amount'],
    rows: TX(8).map((x) => [dmy(x.day), dmy(Math.min(28, x.day + 1)), x.d, eu(x.c, '.', ',')]),
    xs: [40, 120, 200, 440]
  })
  // No table at all
  out.push({ name: 'free_text_no_table', preface: [['This is a letter about your account.'], ['It has no table of transactions at all, only text.'], ['Kind regards, Voorbeeldbank']], header: [], rows: [], xs: [40] })
  return out
}

/** Everything the suite reads: the helper statements, the layouts of tests/pdf-layouts.test.ts and the generated variants. */
export function corpus(): Sample[] {
  const samples: Sample[] = [
    { name: 'ts_statement', bytes: makePdf(STATEMENT_PAGES), own: OWN_IBAN },
    { name: 'ts_statement_flate', bytes: makePdf(STATEMENT_PAGES, { flate: true }), own: OWN_IBAN },
    { name: 'ts_blocks', bytes: makePdf(blockPages(TXS), { flate: true }), own: null },
    { name: 'ts_turned3', bytes: makePdf(turnedPages(3).pages), own: null },
    { name: 'ts_turned12', bytes: makePdf(turnedPages(12).pages, { flate: true }), own: null }
  ]
  for (const l of layouts()) samples.push(build(l))
  return samples
}
