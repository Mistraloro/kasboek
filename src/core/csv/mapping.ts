/**
 * Column mapping: which CSV column means what, plus the date order and decimal mark.
 * Detected from the header names and checked against the data. The names cover the exports of many
 * banks and payment apps in English, Dutch, French, German, Spanish, Portuguese and Italian (ING,
 * Rabobank, ABN AMRO, KBC, Belfius, BNP Paribas, Deutsche Bank, Sparkasse, DKB, N26, Revolut, Wise,
 * PayPal, Monzo, Lloyds, Barclays, Chase, Bank of America, Santander, BBVA, CGD, Intesa, Nubank …);
 * anything else is mapped by hand or by the assistant's check.
 */
import { mappingSchema } from '@shared/import-mapping'
import type { ImportMapping } from '@shared/types'
import { normHeader } from './read'

export { mappingSchema }
export type CsvMapping = ImportMapping
type Field = Exclude<keyof CsvMapping['columns'], 'description'>

/**
 * Header names per field (as normHeader writes them: lower case, no accents, punctuation as spaces),
 * most specific first. Exact matches beat partial ones; partial matches only for names of 5+ letters.
 */
const SYNONYMS: Record<Field | 'description' | 'ignore', string[]> = {
  // The account's own number and name, card numbers and other columns that must not be taken for something else.
  ignore: [
    'nr v/d rekening', 'rekeningnummer', 'rekening', 'naam van de rekening', 'rubrieknaam', 'iban/bban', 'numero de compte', 'compte', 'account', 'account number', 'account name', 'iban rekening',
    'auftragskonto', 'konto', 'accountnum', 'accountlabel', 'product', 'card no', 'card number', 'card last four digits', 'sort code', 'bic', 'bic tegenpartij', 'bic (swift code)', 'beginsaldo',
    'original amount', 'original currency', 'local amount', 'local currency', 'exchange rate', 'gross', 'brutto', 'fee', 'fees', 'total fees', 'mandatsreferenz', 'glaubiger id', 'glaeubiger id',
    'fremde gebuhren', 'lastschrift ursprungsbetrag', 'auslagenersatz rucklastschrift', 'category', 'categoria', 'categorie', 'spending category', 'subcategory', 'code', 'tag', 'emoji', 'receipt', 'time', 'timezone'
  ],
  bookingDate: [
    'boekingsdatum', 'boekdatum', 'transactiedatum', 'uitvoeringsdatum', 'datum', 'date d execution', 'date de comptabilisation', 'date comptable', 'date operation', 'date de l operation', 'dateop',
    'booking date', 'posting date', 'posted date', 'post date', 'transaction date', 'trans date', 'completed date', 'date posted', 'buchungstag', 'buchungsdatum',
    'fecha operacion', 'f operacion', 'fecha', 'data movimento', 'data mov', 'data lancamento', 'data operazione', 'data contabile', 'data', 'date'
  ],
  valueDate: ['valutadatum', 'rentedatum', 'valuta', 'date valeur', 'date de valeur', 'dateval', 'value date', 'valeur', 'wertstellung', 'wert', 'interest date', 'started date', 'fecha valor', 'f valor', 'data valor', 'data valuta'],
  amount: [
    'bedrag', 'bedrag (eur)', 'bedrag in eur', 'transactiebedrag', 'montant', 'montant (eur)', 'montant de l operation', 'amount', 'amount (eur)', 'amount (gbp)', 'amount (usd)', 'transaction amount',
    'betrag', 'betrag (eur)', 'betrag ( )', 'importe', 'importe ( )', 'importe (eur)', 'cantidad', 'montante', 'importo', 'valor', 'net', 'netto'
  ],
  debit: ['debet', 'debit', 'debit amount', 'debit euros', 'af', 'uitgaven', 'soll', 'paid out', 'money out', 'withdrawals', 'withdrawal', 'cargo', 'cargos', 'debito', 'addebiti', 'uscite', 'ausgang'],
  credit: ['credit', 'krediet', 'credit amount', 'credit euros', 'bij', 'inkomsten', 'haben', 'paid in', 'money in', 'deposits', 'deposit', 'abono', 'abonos', 'credito', 'accrediti', 'entrate', 'eingang'],
  direction: ['af bij', 'af/bij', 'debit/credit', 'credit/debit', 'debet/credit', 'credit/debet', 's/h', 'soll/haben', 'dr/cr', 'cr/dr', 'sens', 'debit credit', 'debet credit', 'credit debit indicator'],
  currency: ['munt', 'muntsoort', 'devies', 'munteenheid', 'valuta rekening', 'devise du compte', 'devise', 'currency', 'currency code', 'wahrung', 'waehrung', 'moneda', 'divisa', 'moeda'],
  counterpartyName: [
    'naam tegenpartij', 'naam van de tegenpartij', 'tegenpartij naam', 'naam / omschrijving', 'nom de la contrepartie', 'nom contrepartie', 'counterparty name', 'partner name', 'merchant', 'payee name', 'payer name',
    'counter party', 'begunstigter / auftraggeber', 'auftraggeber / begunstigter', 'beguenstigter/zahlungspflichtiger', 'begunstigter/zahlungspflichtiger', 'zahlungsempfanger in', 'zahlungsempfanger',
    'empfanger', 'supplierfound', 'beneficiario', 'ordenante', 'contraparte', 'beneficiaire', 'tiers', 'counterparty', 'begunstigde', 'payee', 'beneficiary', 'name', 'naam', 'nome'
  ],
  counterpartyIban: [
    'rekening tegenpartij', 'rekeningnummer tegenpartij', 'iban tegenpartij', 'tegenrekening iban/bban', 'tegenrekening', 'tegenpartij', 'compte contrepartie', 'compte de la contrepartie', 'iban contrepartie',
    'contrepartie', 'counterparty account', 'counterparty iban', 'partner iban', 'payee account number', 'kontonummer/iban', 'iban', 'cuenta contrapartida'
  ],
  description: [
    'omschrijving', 'omschrijving 1', 'omschrijving 2', 'omschrijving 3', 'beschrijving', 'details', 'detail van de omzet', 'mutatiesoort', 'transactie', 'description', 'transaction description', 'libelle', 'label',
    'detail de l ecriture', 'type verrichting', 'type de transaction', 'transaction type', 'buchungstext', 'umsatzart', 'umsatztyp', 'verwendungszweck', 'memo', 'narrative', 'omschrijving transactie',
    'concepto', 'descripcion', 'movimiento', 'descricao', 'descrizione', 'operazione', 'dettagli', 'causale', 'lancamento', 'type'
  ],
  communication: ['mededeling', 'mededelingen', 'bericht', 'communication', 'vrije mededeling', 'gestructureerde mededeling', 'message', 'reference de paiement', 'payment reference', 'notes and #tags', 'note', 'notes'],
  bankReference: [
    'transactienummer', 'omzetnummer', 'referentie', 'reference', 'volgnummer', 'volgnr', 'numero de sequence', 'uittrekselnummer', 'extrait', 'transactie id', 'transaction id', 'transferwise id',
    'kundenreferenz', 'kundenreferenz (end to end)', 'identificador', 'referencia', 'check or slip', 'transaction reference', 'id'
  ],
  status: ['status', 'statut', 'state', 'estado', 'stato'],
  balance: [
    'saldo', 'solde', 'balance', 'kontostand', 'saldo na verrichting', 'saldo na transactie', 'saldo na mutatie', 'saldo na trn', 'nieuw saldo', 'eindsaldo', 'solde apres operation', 'solde apres transaction',
    'running balance', 'running bal', 'balance after', 'saldo rekening', 'accountbalance', 'balance (gbp)', 'balance (eur)', 'saldo contabilistico', 'saldo contabile', 'saldo disponible'
  ]
}

/** What a direction column says: money out or in. */
export function directionOf(text: string): -1 | 1 | null {
  const v = normHeader(text)
  if (/^(af|debet|debit|d|dr|s|soll|out|uit|debito|cargo|withdrawal|uitgaand|-)$/.test(v) || text.trim() === '-') return -1
  if (/^(bij|credit|c|cr|h|haben|in|credito|abono|deposit|inkomend|\+)$/.test(v) || text.trim() === '+') return 1
  return null
}

export function scoreHeaderRow(cells: string[]): number {
  const all = new Set(Object.values(SYNONYMS).flat())
  return cells.filter((c) => all.has(normHeader(c))).length
}

/** First row that looks like a header (bank exports may start with a few info lines). */
export function findHeaderRow(rows: string[][]): number {
  let best = 0
  let bestScore = 0
  rows.slice(0, 15).forEach((r, i) => {
    const s = scoreHeaderRow(r)
    if (s > bestScore) {
      best = i
      bestScore = s
    }
  })
  return bestScore >= 2 ? best : 0
}

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9 ]{10,30}$/i
const DATEISH = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}( .*)?$|^\d{8}$|^\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{2,4}$|^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/

export function autoMap(rows: string[][], delimiter: CsvMapping['delimiter']): CsvMapping | null {
  const headerRow = findHeaderRow(rows)
  const headers = (rows[headerRow] ?? []).map(normHeader)
  const data = rows.slice(headerRow + 1, headerRow + 40)
  const used = new Set<number>()
  const cols: Partial<Record<Field, number>> & { description: number[] } = { description: [] }
  const columnValues = (i: number): string[] => data.map((r) => r[i] ?? '').filter(Boolean)

  const claim = (field: Field | 'ignore', exactOnly: boolean): void => {
    // Partial matches only for longer names, and never for columns we ignore.
    if (!exactOnly && field === 'ignore') return
    for (const syn of SYNONYMS[field]) {
      if (!exactOnly && syn.length < 5) continue
      const i = headers.findIndex((h, idx) => !used.has(idx) && (exactOnly ? h === syn : h.includes(syn)))
      if (i >= 0) {
        used.add(i)
        if (field !== 'ignore') cols[field] = i
        return
      }
    }
  }
  const order: (Field | 'ignore')[] = ['ignore', 'bookingDate', 'valueDate', 'currency', 'counterpartyName', 'counterpartyIban', 'amount', 'debit', 'credit', 'direction', 'communication', 'bankReference', 'status', 'balance']
  for (const exact of [true, false]) for (const f of order) if (f === 'ignore' || cols[f as Field] === undefined) claim(f, exact)
  for (const syn of SYNONYMS.description) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && h === syn)
    if (i >= 0) {
      used.add(i)
      cols.description.push(i)
    }
  }

  // A "counterparty" column full of IBANs is the account, not the name (and the other way round).
  const looksIban = (i: number | undefined): boolean => i !== undefined && columnValues(i).filter((v) => IBAN.test(v)).length > columnValues(i).length / 2
  if (cols.counterpartyName !== undefined && looksIban(cols.counterpartyName) && cols.counterpartyIban === undefined) {
    cols.counterpartyIban = cols.counterpartyName
    delete cols.counterpartyName
  }
  // A direction column only counts when its values say out or in ("Af"/"Bij", "S"/"H", …).
  if (cols.direction !== undefined) {
    const v = columnValues(cols.direction)
    if (!v.length || v.filter((x) => directionOf(x) !== null).length < v.length * 0.8) delete cols.direction
  }
  // "Valuta" is the value date in Dutch but the currency in Italian: three-letter codes mean currency.
  if (cols.valueDate !== undefined && cols.currency === undefined) {
    const v = columnValues(cols.valueDate)
    if (v.length && v.every((x) => /^[A-Z]{3}$/.test(x))) {
      cols.currency = cols.valueDate
      delete cols.valueDate
    }
  }
  // No date header recognised: take the first column that holds dates.
  if (cols.bookingDate === undefined) {
    const i = headers.findIndex((_, idx) => !used.has(idx) && columnValues(idx).length > 0 && columnValues(idx).every((v) => DATEISH.test(v)))
    if (i >= 0) cols.bookingDate = i
  }
  if (cols.bookingDate === undefined || (cols.amount === undefined && cols.debit === undefined && cols.credit === undefined)) return null

  const dateSamples = columnValues(cols.bookingDate)
  const amountSamples = [cols.amount, cols.debit, cols.credit].flatMap((i) => (i === undefined ? [] : columnValues(i)))
  return mappingSchema.parse({
    delimiter,
    headerRow,
    dateOrder: detectDateOrder(dateSamples),
    decimal: detectDecimal(amountSamples),
    invertSign: false,
    columns: cols
  })
}

export function detectDateOrder(samples: string[]): CsvMapping['dateOrder'] {
  let dmy = 0
  let mdy = 0
  for (const s of samples) {
    if (/^\d{4}[-/.]/.test(s) || /^\d{8}$/.test(s)) return 'YMD'
    const [a, b] = s.split(/[-/.]/).map(Number) as [number, number]
    if (a > 12) dmy++
    if (b > 12) mdy++
  }
  return mdy > dmy ? 'MDY' : 'DMY' // day first unless the dates show otherwise
}

export function detectDecimal(samples: string[]): ',' | '.' {
  let comma = 0
  let dot = 0
  for (const s of samples) {
    if (/,\d{1,2}-?$/.test(s.trim())) comma++
    else if (/\.\d{1,2}-?$/.test(s.trim())) dot++
  }
  return dot > comma ? '.' : ','
}

/** Well-known exports, by header names that only they have together. Only a label ("layout recognised"). */
const LAYOUTS: [string, string[][]][] = [
  ['argenta', [['nr v/d rekening'], ['boekdatum', 'naam tegenpartij', 'munt']]],
  ['hellobank', [['volgnummer', 'uitvoeringsdatum'], ['numero de sequence', 'date d execution']]],
  ['keytrade', [['uittrekselnummer'], ['extrait', 'devise']]],
  ['kbc', [['rubrieknaam', 'afschriftnummer']]],
  ['belfius', [['rekeninguittrekselnummer', 'naam tegenpartij bevat']]],
  ['ing-be', [['omzetnummer', 'detail van de omzet']]],
  ['ing-nl', [['naam / omschrijving', 'af bij']]],
  ['rabobank', [['iban/bban', 'volgnr', 'saldo na trn']]],
  ['abn-amro', [['transactiedatum', 'transactiebedrag', 'muntsoort']]],
  ['deutsche-bank', [['begunstigter / auftraggeber', 'umsatzart']]],
  ['sparkasse', [['auftragskonto', 'beguenstigter/zahlungspflichtiger']]],
  ['dkb', [['zahlungsempfanger in', 'wertstellung']]],
  ['n26', [['partner name', 'partner iban']]],
  ['revolut', [['started date', 'completed date', 'product']]],
  ['wise', [['transferwise id']]],
  ['paypal', [['gross', 'fee', 'net', 'transaction id']]],
  ['monzo', [['money out', 'money in', 'local amount']]],
  ['lloyds', [['sort code', 'debit amount', 'credit amount']]],
  ['chase', [['posting date', 'check or slip']]],
  ['boursorama', [['dateop', 'dateval', 'supplierfound']]]
]

/**
 * Recognises well-known layouts from their header rows, to report "layout recognised". This is only
 * a label: any bank's CSV is mapped from its column names by autoMap.
 */
export function detectLayout(headerCells: string[]): string | null {
  const h = new Set(headerCells.map(normHeader))
  return LAYOUTS.find(([, sets]) => sets.some((set) => set.every((x) => h.has(x))))?.[0] ?? null
}

export const headerSignature = (cells: string[], delimiter: string): string => `${delimiter}|${cells.map(normHeader).join('|')}`
