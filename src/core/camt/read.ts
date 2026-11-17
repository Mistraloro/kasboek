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
  opening: number | null
  closing: number | null
  from: string | null
  to: string | null
  rows: CamtRow[]
  /** Entries that are not booked (pending, information only). */
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

/** Decimal text ("1234.5", "0.075") as cents, rounding half up; null for anything else (also negative text and huge values). */
export function centsOf(text: string): number | null {
  const m = /^(\d{1,15})(?:\.(\d{1,10}))?$/.exec(text.trim())
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(3, '0')
  const cents = Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0)
  return Number.isSafeInteger(cents) ? cents : null
}

function formatCents(cents: number): string {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** The date part of "2026-03-04" or "2026-03-04T10:00:00+01:00"; the clock and zone are not used. */
const isoDay = (text: string): string => /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? ''
/** The date of a Dt/DtTm choice element (BookgDt, ValDt, a balance's Dt). */
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

const allTxDetails = (entry: XmlNode): XmlNode[] => children(entry, 'NtryDtls').flatMap((d) => children(d, 'TxDtls'))

interface Detail {
  counterparty: string
  counterpartyIban: string
  description: string
  communication: string
  reference: string
}

/** Names, account, remittance text and references of one transaction (one TxDtls, or the entry alone). */
function detailOf(entry: XmlNode, tx: XmlNode | undefined, debit: boolean, bookingDate: string, single: boolean): Detail {
  const parties = child(tx, 'RltdPties')
  // Money out: the other side is the creditor; money in: the debtor.
  const side = debit ? 'Cdtr' : 'Dbtr'
  const ultimate = debit ? 'UltmtCdtr' : 'UltmtDbtr'
  const counterparty = partyName(child(parties, side)) || partyName(child(parties, ultimate))
  const counterpartyIban = accountId(child(parties, `${side}Acct`)) || accountId(child(parties, `${ultimate}Acct`))

  const rmt = child(tx, 'RmtInf')
  const unstructured = children(rmt, 'Ustrd').map((u) => u.text).filter(Boolean)
  const structured = children(rmt, 'Strd')
  const extra = structured.flatMap((s) => children(s, 'AddtlRmtInf').map((a) => a.text)).filter(Boolean)
  const communication = structured.map((s) => textAt(s, 'CdtrRefInf', 'Ref')).find(Boolean) ?? ''
  const code = path(entry, 'BkTxCd', 'Domn')
  const bankCode = [textAt(code, 'Cd'), textAt(code, 'Fmly', 'Cd'), textAt(code, 'Fmly', 'SubFmlyCd')].filter(Boolean).join('/') || textAt(entry, 'BkTxCd', 'Prtry', 'Cd')
  const description = [...unstructured, ...extra].join(' ') || textAt(tx, 'AddtlTxInf') || (single ? textAt(entry, 'AddtlNtryInf') : '') || bankCode

  // The bank's own reference is unique. An end-to-end id is the payer's: a standing order can repeat it
  // every month, so it only counts together with the booking date.
  const refs = child(tx, 'Refs')
  const own = textAt(refs, 'AcctSvcrRef') || (single ? textAt(entry, 'AcctSvcrRef') : '')
  const e2e = textAt(refs, 'EndToEndId')
  const reference = own || (e2e && !/^NOTPROVIDED$/i.test(e2e) ? `${e2e} ${bookingDate}` : '')
  return { counterparty, counterpartyIban, description, communication, reference }
}

interface EntryResult {
  rows: CamtRow[]
  booked: boolean
}

function readEntry(entry: XmlNode, statementCurrency: string): EntryResult {
  const status = textAt(entry, 'Sts') || textAt(entry, 'Sts', 'Cd')
  if (status && status.toUpperCase() !== 'BOOK') return { rows: [], booked: false }

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

  const txs = allTxDetails(entry)
  if (txs.length > 1) {
    // A batch: one row per transaction with its own amount, when those amounts add up to the entry's.
    const own = txs.map((tx) => ({ tx, node: path(tx, 'Amt') ?? path(tx, 'AmtDtls', 'TxAmt', 'Amt') }))
    const cents = own.map((o) => (o.node ? centsOf(o.node.text) : null))
    const sameCurrency = own.every((o) => (o.node?.attrs.Ccy ?? currency).toUpperCase() === currency)
    if (entryCents !== null && sameCurrency && cents.every((c) => c !== null) && cents.reduce((t, c) => t + c!, 0) === entryCents) {
      return { booked: true, rows: own.map((o, i) => ({ ...base, amount: signed(cents[i]!), ...detailOf(entry, o.tx, debit, bookingDate, false) })) }
    }
    // Otherwise one row for the entry; the remittance texts of all its transactions are kept.
    const details = txs.map((tx) => detailOf(entry, tx, debit, bookingDate, false))
    const joined = details.map((d) => d.description).filter(Boolean).join(' · ')
    return { booked: true, rows: [{ ...base, amount: signed(entryCents), counterparty: '', counterpartyIban: '', description: joined || textAt(entry, 'AddtlNtryInf'), communication: '', reference: textAt(entry, 'AcctSvcrRef') }] }
  }
  return { booked: true, rows: [{ ...base, amount: signed(entryCents), ...detailOf(entry, txs[0], debit, bookingDate, true) }] }
}

// --------------------------------------------------------------------------------- statements

function readStatement(node: XmlNode): CamtStatement {
  const acct = child(node, 'Acct')
  const iban = textAt(acct, 'Id', 'IBAN').replace(/\s+/g, '').toUpperCase()
  const account = iban || accountId(acct)
  const bals = children(node, 'Bal').map((b) => ({ code: textAt(b, 'Tp', 'CdOrPrtry', 'Cd'), bal: b }))
  // Opening: OPBD, else the previous day's closing (PRCD). Closing: CLBD, else the available closing (CLAV).
  const pick = (...codes: string[]): XmlNode | undefined => codes.map((c) => bals.find((b) => b.code === c)?.bal).find(Boolean)
  const open = pick('OPBD', 'PRCD')
  const close = pick('CLBD', 'CLAV')
  const period = child(node, 'FrToDt')

  const currency = textAt(acct, 'Ccy') || (open ? (child(open, 'Amt')?.attrs.Ccy ?? '') : '')
  const entries = children(node, 'Ntry')
  const rows: CamtRow[] = []
  let notBooked = 0
  for (const entry of entries) {
    const read = readEntry(entry, currency)
    if (!read.booked) notBooked++
    rows.push(...read.rows)
  }
  return {
    account,
    isIban: !!iban,
    opening: open ? balanceCents(open) : null,
    closing: close ? balanceCents(close) : null,
    from: dateOf(child(open, 'Dt')) || isoDay(textAt(period, 'FrDtTm')) || null,
    to: dateOf(child(close, 'Dt')) || isoDay(textAt(period, 'ToDtTm')) || null,
    rows,
    notBooked
  }
}

/** The elements that hold one account's entries: Stmt (053), Rpt (052) and Ntfctn (054), wherever they sit. */
function statementNodes(root: XmlNode): XmlNode[] {
  const found: XmlNode[] = []
  const todo = [root]
  while (todo.length) {
    const n = todo.shift()!
    if (n.name === 'Stmt' || n.name === 'Rpt' || n.name === 'Ntfctn') found.push(n)
    else todo.unshift(...n.children)
  }
  return found
}

export interface CamtRead {
  statements: CamtStatement[]
}

/** Reads the bytes of a CAMT file; throws an AppError with a plain explanation when it is not one. */
export function readCamt(bytes: Uint8Array): CamtRead {
  if (bytes.length > MAX_XML_BYTES) throw new AppError('import.xml_too_large', 'This file is larger than 20 MB.')
  let root: XmlNode
  try {
    root = parseXml(decodeXml(bytes))
  } catch (e) {
    if (!(e instanceof XmlError)) throw e
    if (e.failure === 'dtd') throw new AppError('import.xml_dtd', 'This XML file contains a DTD or entity definitions, which Kasboek does not read. Bank statements do not need them.')
    if (e.failure === 'too_large') throw new AppError('import.xml_too_large', 'This file is larger than 20 MB.')
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
  if (nodes.reduce((t, n) => t + children(n, 'Ntry').length, 0) > MAX_ENTRIES) throw new AppError('import.too_many', 'This file has more than 50,000 rows.')
  return { statements: nodes.map(readStatement) }
}
