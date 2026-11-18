/**
 * Reads an ISO 20022 bank statement (CAMT.053; CAMT.052 and CAMT.054 lists of entries too) into rows.
 * Names are matched without namespace, so every version (.001.02, .001.08, …) reads the same way.
 * Amounts are exact (text to cents, never a float) and the sign comes from the credit/debit
 * indicator, never from a guess. Nothing is read from the network or run.
 */
import { AppError } from '../errors'
import { parseXml, XmlError, type XmlNode } from './xml'

export const MAX_XML_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 50_000
/** More statements than this in one file is not a statement file anyone downloads. */
const MAX_STATEMENTS = 1_000
/** Versions of camt.052/053/054 whose entries are read (.001.01 to .001.14). */
const MAX_VERSION = 14

export interface CamtRow {
  bookingDate: string
  valueDate: string
  /** Signed cents as text with a decimal point ("-12.50"); empty when the file's amount or indicator is unusable. */
  amount: string
  currency: string
  counterparty: string
  counterpartyIban: string
  description: string
  communication: string
  reference: string
}

export interface CamtStatement {
  /** The account's IBAN, else its other identification, else ''. */
  account: string
  isIban: boolean
  /** The statement's currency (account, else opening balance), '' when the file does not say. */
  currency: string
  opening: number | null
  /** The closing booked balance (CLBD), else the intraday one (ITBD); never the available balance (CLAV). */
  closing: number | null
  /** Whether closing is the real closing balance (CLBD), so it may be recorded as the bank's balance. */
  closingIsFinal: boolean
  from: string | null
  to: string | null
  rows: CamtRow[]
  /** Entries that are not booked (pending, or for information only). */
  notBooked: number
}

// ------------------------------------------------------------------------------------ helpers

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name)
const children = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? []
const path = (n: XmlNode | undefined, ...names: string[]): XmlNode | undefined => names.reduce<XmlNode | undefined>((cur, name) => child(cur, name), n)
const textAt = (n: XmlNode | undefined, ...names: string[]): string => path(n, ...names)?.text ?? ''

/** Text to bytes to text: UTF-8 (also with a BOM), UTF-16 with a BOM, or the encoding the XML declaration names. */
export function decodeXml(bytes: Uint8Array): string {
  const b = bytes
  let label = 'utf-8'
  if (b[0] === 0xff && b[1] === 0xfe) label = 'utf-16le'
  else if (b[0] === 0xfe && b[1] === 0xff) label = 'utf-16be'
  else if (b[0] === 0x3c && b[1] === 0x00) label = 'utf-16le'
  else if (b[0] === 0x00 && b[1] === 0x3c) label = 'utf-16be'
  else {
    const declared = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(new TextDecoder('latin1').decode(b.subarray(0, 200)))
    if (declared) label = declared[1]!.toLowerCase()
  }
  try {
    return new TextDecoder(label).decode(b)
  } catch {
    throw new AppError('import.xml_broken', 'This XML file could not be read. The file may be damaged. Download it again from your bank.')
  }
}

/**
 * Decimal text as cents, rounding half up. Takes the forms of xs:decimal ("1234.5", ".5", "1.", "+1.00",
 * "0.075"); null for anything else (also negative text, thousands separators and huge values).
 */
export function centsOf(text: string): number | null {
  const m = /^\+?(\d{0,15})(?:\.(\d{0,10}))?$/.exec(text.trim())
  if (!m || (!m[1] && !m[2])) return null
  const frac = (m[2] ?? '').padEnd(3, '0')
  const cents = Number(m[1] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0)
  return Number.isSafeInteger(cents) ? cents : null
}

function formatCents(cents: number): string {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * The date part of "2026-03-04" or "2026-03-04T10:00:00+01:00"; the clock and zone are not used. A
 * date-time is taken as the date the bank wrote, with no conversion to the local time zone, so the day
 * matches the bank's own statement.
 */
const isoDay = (text: string): string => /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? ''
/** The date of a Dt/DtTm choice element (BookgDt, ValDt, a balance's Dt); Dt is preferred over DtTm. */
const dateOf = (n: XmlNode | undefined): string => isoDay(textAt(n, 'Dt') || textAt(n, 'DtTm'))

/** A balance's amount with its sign, or null. */
function balanceCents(bal: XmlNode): number | null {
  const cents = centsOf(textAt(bal, 'Amt'))
  const dir = textAt(bal, 'CdtDbtInd')
  if (cents === null || (dir !== 'CRDT' && dir !== 'DBIT')) return null
  return dir === 'DBIT' ? -cents : cents
}

// ----------------------------------------------------------------------------------- entries

/** Name of a party: Nm, or Pty/Nm in the newer versions. */
const partyName = (p: XmlNode | undefined): string => textAt(p, 'Nm') || textAt(p, 'Pty', 'Nm')

function accountId(acct: XmlNode | undefined): string {
  const id = child(acct, 'Id')
  return (textAt(id, 'IBAN') || textAt(id, 'Othr', 'Id')).replace(/\s+/g, '').toUpperCase()
}

const tooLarge = (): AppError => new AppError('import.xml_too_large', 'This file is larger than 20 MB or has more than 50,000 rows.')

const allTxDetails = (entry: XmlNode): XmlNode[] => children(entry, 'NtryDtls').flatMap((d) => children(d, 'TxDtls'))

interface Detail {
  counterparty: string
  counterpartyIban: string
  description: string
  communication: string
  reference: string
}

/** What an entry itself says, looked up once per entry (not once per transaction of a large batch). */
interface EntryInfo {
  bankCode: string
  reference: string
  additional: string
}

function entryInfoOf(entry: XmlNode): EntryInfo {
  const code = path(entry, 'BkTxCd', 'Domn')
  const bankCode = [textAt(code, 'Cd'), textAt(code, 'Fmly', 'Cd'), textAt(code, 'Fmly', 'SubFmlyCd')].filter(Boolean).join('/') || textAt(entry, 'BkTxCd', 'Prtry', 'Cd')
  return { bankCode, reference: textAt(entry, 'AcctSvcrRef'), additional: textAt(entry, 'AddtlNtryInf') }
}

/** Names, account, remittance text and references of one transaction (one TxDtls, or the entry alone). */
function detailOf(info: EntryInfo, tx: XmlNode | undefined, debit: boolean, single: boolean, statementIban: string): Detail {
  const parties = child(tx, 'RltdPties')
  // Money out: the other side is the creditor; money in: the debtor. A reversal can list the parties the
  // other way round, so a side whose account is the statement's own is not the counterparty.
  const sides = debit ? (['Cdtr', 'Dbtr'] as const) : (['Dbtr', 'Cdtr'] as const)
  const other = statementIban ? sides.find((s) => { const iban = accountId(child(parties, `${s}Acct`)); return !!iban && iban !== statementIban }) : undefined
  const side = other ?? sides[0]
  const ultimate = side === 'Cdtr' ? 'UltmtCdtr' : 'UltmtDbtr'
  const counterparty = partyName(child(parties, side)) || partyName(child(parties, ultimate))
  const counterpartyIban = accountId(child(parties, `${side}Acct`)) || accountId(child(parties, `${ultimate}Acct`))

  const rmt = child(tx, 'RmtInf')
  const unstructured = children(rmt, 'Ustrd').map((u) => u.text).filter(Boolean)
  const structured = children(rmt, 'Strd')
  const extra = structured.flatMap((s) => children(s, 'AddtlRmtInf').map((a) => a.text)).filter(Boolean)
  const communication = structured.map((s) => textAt(s, 'CdtrRefInf', 'Ref')).find(Boolean) ?? ''
  const description = [...unstructured, ...extra].join(' ') || textAt(tx, 'AddtlTxInf') || (single ? info.additional : '') || info.bankCode

  // Only the bank's own reference is a reference. An end-to-end id is the payer's (a standing order repeats
  // it every month) and is not in a CSV export of the same history, so it is not used at all: such a row is
  // recognised again by its date, amount and text, as a CSV row is.
  const refs = child(tx, 'Refs')
  const reference = textAt(refs, 'AcctSvcrRef') || (single ? info.reference : '')
  return { counterparty, counterpartyIban, description, communication, reference }
}

interface EntryResult {
  rows: CamtRow[]
  booked: boolean
}

/** Status of an entry: "BOOK" in the older layout; Sts/Cd or Sts/Prtry/Cd in version 10 and later. Missing counts as booked. */
const statusOf = (entry: XmlNode): string => (textAt(entry, 'Sts') || textAt(entry, 'Sts', 'Cd') || textAt(entry, 'Sts', 'Prtry', 'Cd') || textAt(entry, 'Sts', 'Prtry')).toUpperCase()

function readEntry(entry: XmlNode, statementCurrency: string, statementIban: string, room: number): EntryResult {
  const status = statusOf(entry)
  if (status && status !== 'BOOK') return { rows: [], booked: false }

  const amt = child(entry, 'Amt')
  const currency = (amt?.attrs.Ccy ?? statementCurrency).toUpperCase()
  const indicator = textAt(entry, 'CdtDbtInd')
  const debit = indicator === 'DBIT'
  // Whether money came in or went out is the file's CdtDbtInd, which is the direction on the account
  // (also for a reversal, RvslInd); anything else leaves the amount empty so the row is flagged.
  const signed = (cents: number | null): string => (cents === null || (indicator !== 'CRDT' && !debit) ? '' : formatCents(debit ? -cents : cents))
  const entryCents = centsOf(amt?.text ?? '')
  const bookingDate = dateOf(child(entry, 'BookgDt')) || dateOf(child(entry, 'ValDt'))
  const valueDate = dateOf(child(entry, 'ValDt'))
  const base = { bookingDate, valueDate, currency }

  const info = entryInfoOf(entry)
  const txs = allTxDetails(entry)
  if (txs.length > 1) {
    if (txs.length > room) throw tooLarge()
    // A batch: one row per transaction with its own amount, when those amounts add up to the entry's.
    const own = txs.map((tx) => ({ tx, node: path(tx, 'Amt') ?? path(tx, 'AmtDtls', 'TxAmt', 'Amt') }))
    const cents = own.map((o) => (o.node ? centsOf(o.node.text) : null))
    const sameCurrency = own.every((o) => (o.node?.attrs.Ccy ?? currency).toUpperCase() === currency)
    if (entryCents !== null && sameCurrency && cents.every((c) => c !== null) && cents.reduce((t, c) => t + c!, 0) === entryCents) {
      return { booked: true, rows: own.map((o, i) => ({ ...base, amount: signed(cents[i]!), ...detailOf(info, o.tx, debit, false, statementIban) })) }
    }
    // Otherwise one row for the entry; the remittance texts of all its transactions are kept.
    const details = txs.map((tx) => detailOf(info, tx, debit, false, statementIban))
    const joined = details.map((d) => d.description).filter(Boolean).join(' · ')
    return { booked: true, rows: [{ ...base, amount: signed(entryCents), counterparty: '', counterpartyIban: '', description: joined || info.additional, communication: '', reference: info.reference }] }
  }
  return { booked: true, rows: [{ ...base, amount: signed(entryCents), ...detailOf(info, txs[0], debit, true, statementIban) }] }
}

// --------------------------------------------------------------------------------- statements

function readStatement(node: XmlNode, budget: { left: number }): CamtStatement {
  const acct = child(node, 'Acct')
  const iban = textAt(acct, 'Id', 'IBAN').replace(/\s+/g, '').toUpperCase()
  const account = iban || accountId(acct)
  const bals = children(node, 'Bal').map((b) => ({ code: textAt(b, 'Tp', 'CdOrPrtry', 'Cd'), bal: b }))
  // Opening: OPBD, else the previous day's closing (PRCD).
  const pick = (...codes: string[]): XmlNode | undefined => codes.map((c) => bals.find((b) => b.code === c)?.bal).find(Boolean)
  const open = pick('OPBD', 'PRCD')
  // Closing: CLBD, else the intraday ITBD. Never CLAV: the available balance includes a credit line.
  const close = pick('CLBD', 'ITBD')
  const period = child(node, 'FrToDt')

  const currency = textAt(acct, 'Ccy') || (open ? (child(open, 'Amt')?.attrs.Ccy ?? '') : '')
  const entries = children(node, 'Ntry')
  const rows: CamtRow[] = []
  let notBooked = 0
  for (const entry of entries) {
    const read = readEntry(entry, currency, iban, budget.left)
    if (!read.booked) notBooked++
    budget.left -= read.rows.length
    for (const row of read.rows) rows.push(row)
  }
  return {
    account,
    isIban: !!iban,
    currency: currency.toUpperCase(),
    opening: open ? balanceCents(open) : null,
    closing: close ? balanceCents(close) : null,
    closingIsFinal: !!close && textAt(close.children.find((c) => c.name === 'Tp'), 'CdOrPrtry', 'Cd') === 'CLBD',
    from: dateOf(child(open, 'Dt')) || isoDay(textAt(period, 'FrDtTm')) || null,
    to: dateOf(child(close, 'Dt')) || isoDay(textAt(period, 'ToDtTm')) || null,
    rows,
    notBooked
  }
}

/** The elements that hold one account's entries: Stmt (053), Rpt (052) and Ntfctn (054), wherever they sit. */
function statementNodes(root: XmlNode): XmlNode[] {
  const found: XmlNode[] = []
  // Depth first in document order, without spreading the children (a file can have very many).
  const todo = [root]
  while (todo.length) {
    const n = todo.pop()!
    if (n.name === 'Stmt' || n.name === 'Rpt' || n.name === 'Ntfctn') found.push(n)
    else for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]!)
  }
  return found
}

export interface CamtRead {
  statements: CamtStatement[]
}

/** Reads the bytes of a CAMT file; throws an AppError with a plain explanation when it is not one. */
export function readCamt(bytes: Uint8Array, maxRows = MAX_ENTRIES): CamtRead {
  if (bytes.length > MAX_XML_BYTES) throw tooLarge()
  try {
    return readCamtBytes(bytes, maxRows)
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('import.xml_broken', 'This XML file could not be read. The file may be damaged. Download it again from your bank.')
  }
}

function readCamtBytes(bytes: Uint8Array, maxRows: number): CamtRead {
  let root: XmlNode
  try {
    root = parseXml(decodeXml(bytes))
  } catch (e) {
    if (!(e instanceof XmlError)) throw e
    if (e.failure === 'dtd') throw new AppError('import.xml_dtd', 'This XML file contains a DTD or entity definitions, which Kasboek does not read. Bank statements do not need them.')
    if (e.failure === 'too_large') throw tooLarge()
    throw new AppError('import.xml_broken', 'This XML file could not be read. The file may be damaged. Download it again from your bank.')
  }
  // The message type and version are in the namespace of the Document element, when there is one.
  const ns = Object.values(root.attrs).map((v) => /camt\.(\d{3})\.\d{3}\.(\d{2})/.exec(v)).find(Boolean)
  if (ns) {
    if (!['052', '053', '054'].includes(ns[1]!)) throw new AppError('import.xml_not_camt', 'This XML file is not a bank statement (CAMT.053).')
    if (Number(ns[2]) < 1 || Number(ns[2]) > MAX_VERSION) throw new AppError('import.xml_version', 'This version of the CAMT format is not supported. Ask your bank for CAMT.053 version 001.02 or later.')
  }
  const nodes = statementNodes(root)
  if (!nodes.length) throw new AppError('import.xml_not_camt', 'This XML file is not a bank statement (CAMT.053).')
  if (nodes.length > MAX_STATEMENTS) throw tooLarge()
  if (nodes.reduce((t, n) => t + children(n, 'Ntry').length, 0) > maxRows) throw tooLarge()
  // The rows of all statements together are counted while they are read, so a batch entry with very many
  // transactions is refused before its rows are built.
  const budget = { left: maxRows }
  return { statements: nodes.map((n) => readStatement(n, budget)) }
}
