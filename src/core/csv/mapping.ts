/**
 * Column mapping: which CSV column means what, plus the date order and decimal mark.
 * Detected from the header names (Dutch, French, English, German) and checked against the data.
 */
import { mappingSchema } from '@shared/import-mapping'
import type { Bank, ImportMapping } from '@shared/types'
import { normHeader } from './read'

export { mappingSchema }
export type CsvMapping = ImportMapping
type Field = Exclude<keyof CsvMapping['columns'], 'description'>

/** Header names per field, most specific first. Exact matches beat partial matches. */
const SYNONYMS: Record<Field | 'description' | 'ignore', string[]> = {
  ignore: ['nr v/d rekening', 'rekeningnummer', 'rekening', 'numero de compte', 'compte', 'account', 'account number', 'iban rekening'],
  bookingDate: ['boekingsdatum', 'boekdatum', 'uitvoeringsdatum', 'date d execution', 'date de comptabilisation', 'date comptable', 'booking date', 'buchungstag', 'transaction date', 'datum', 'date'],
  valueDate: ['valutadatum', 'valuta', 'date valeur', 'date de valeur', 'value date', 'valeur', 'wertstellung'],
  amount: ['bedrag', 'montant', 'amount', 'betrag', 'bedrag (eur)', 'montant (eur)', 'bedrag in eur'],
  debit: ['debet', 'debit', 'af', 'uitgaven', 'soll'],
  credit: ['credit', 'krediet', 'bij', 'inkomsten', 'haben'],
  currency: ['munt', 'devies', 'munteenheid', 'valuta rekening', 'devise du compte', 'devise', 'currency', 'wahrung'],
  counterpartyName: ['naam tegenpartij', 'naam van de tegenpartij', 'tegenpartij naam', 'nom de la contrepartie', 'nom contrepartie', 'counterparty name', 'counterparty', 'begunstigde', 'payee', 'beneficiary', 'merchant', 'name', 'naam'],
  counterpartyIban: ['rekening tegenpartij', 'rekeningnummer tegenpartij', 'iban tegenpartij', 'tegenpartij', 'compte contrepartie', 'compte de la contrepartie', 'contrepartie', 'counterparty account', 'counterparty iban'],
  description: ['omschrijving', 'beschrijving', 'details', 'description', 'libelle', 'type verrichting', 'type de transaction', 'transaction type', 'verwendungszweck', 'memo', 'narrative', 'omschrijving transactie'],
  communication: ['mededeling', 'communication', 'vrije mededeling', 'gestructureerde mededeling', 'message', 'reference de paiement'],
  bankReference: ['referentie', 'reference', 'volgnummer', 'numero de sequence', 'uittrekselnummer', 'extrait', 'transactie id', 'transaction id'],
  status: ['status', 'statut']
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
const DATEISH = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d{8}$/

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
  const order: (Field | 'ignore')[] = ['ignore', 'bookingDate', 'valueDate', 'currency', 'counterpartyName', 'counterpartyIban', 'amount', 'debit', 'credit', 'communication', 'bankReference', 'status']
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
  return mdy > dmy ? 'MDY' : 'DMY' // Belgian default is day first
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

/** Recognises the three banks with built-in support from their header rows. */
export function detectBank(headerCells: string[]): Bank | null {
  const h = headerCells.map(normHeader)
  const has = (x: string): boolean => h.includes(x)
  if (has('nr v/d rekening') || (has('boekdatum') && has('naam tegenpartij') && has('munt'))) return 'argenta'
  if ((has('volgnummer') && has('uitvoeringsdatum')) || (has('numero de sequence') && has('date d execution'))) return 'hellobank'
  if (has('uittrekselnummer') || ((has('extrait') || has('extrait n')) && (has('devise') || has('devies')))) return 'keytrade'
  return null
}

export const headerSignature = (cells: string[], delimiter: string): string => `${delimiter}|${cells.map(normHeader).join('|')}`
