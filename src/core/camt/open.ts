import type { Db } from '../database'
import { AppError } from '../errors'
import { analyzeXmlGrid, type XmlSessionData } from '../import'
import type { CsvMapping } from '../csv/mapping'
import { maskIban } from '@shared/iban'
import type { ImportPreview } from '@shared/types'
import { readCamt, type CamtRow, type CamtStatement } from './read'

/** The columns of the grid an XML statement is turned into (the header names are Kasboek's own). */
const HEADER = ['Booking date', 'Value date', 'Amount', 'Currency', 'Counterparty', 'Counterparty IBAN', 'Description', 'Communication', 'Reference']
const MAPPING: CsvMapping = {
  delimiter: ',',
  headerRow: 0,
  dateOrder: 'YMD',
  decimal: '.',
  invertSign: false,
  columns: { bookingDate: 0, valueDate: 1, amount: 2, currency: 3, counterpartyName: 4, counterpartyIban: 5, description: [6], communication: 7, bankReference: 8 }
}

const gridRow = (r: CamtRow): string[] => [r.bookingDate, r.valueDate, r.amount, r.currency, r.counterparty, r.counterpartyIban, r.description, r.communication, r.reference]
const compact = (iban: string | null): string => (iban ?? '').replace(/\s+/g, '').toUpperCase()

/**
 * Opens an import session from an XML (CAMT) statement. A file can hold several accounts: the
 * statements of the chosen account are used (matched by IBAN); a file of one account is used as it is
 * (with a remark when its IBAN is not the chosen account's); a file of several accounts none of which
 * is the chosen one is refused, so rows never land in the wrong account.
 */
export function openXmlSession(db: Db, input: { fileName: string; accountId: number; bytes: Uint8Array }): ImportPreview {
  const account = db.prepare('SELECT iban FROM accounts WHERE id = ?').get(input.accountId) as { iban: string | null } | undefined
  if (!account) throw new AppError('accounts.not_found', 'Choose an account first.')
  const own = compact(account.iban)

  const { statements } = readCamt(input.bytes)
  const groups = new Map<string, CamtStatement[]>()
  for (const st of statements) groups.set(st.account, [...(groups.get(st.account) ?? []), st])

  const notes: XmlSessionData['notes'] = []
  let chosen: CamtStatement[]
  if (own && groups.has(own)) {
    chosen = groups.get(own)!
    if (groups.size > 1) notes.push({ code: 'accounts_left_out', count: groups.size - 1 })
  } else if (groups.size === 1) {
    chosen = [...groups.values()][0]!
    const [first] = chosen
    if (own && first!.isIban && first!.account) notes.push({ code: 'other_account', iban: maskIban(first!.account) })
  } else throw new AppError('import.xml_accounts', 'This file holds statements for more than one account, and none of them is the chosen account. Add the account’s IBAN in Settings, choose that account and open the file again.')

  // Statements of one account in date order: the first one's opening and the last one's closing balance count.
  const ordered = [...chosen].sort((a, b) => (a.from ?? a.rows[0]?.bookingDate ?? '').localeCompare(b.from ?? b.rows[0]?.bookingDate ?? ''))
  const notBooked = ordered.reduce((t, st) => t + st.notBooked, 0)
  if (notBooked) notes.push({ code: 'not_booked', count: notBooked })
  const dates = (key: 'from' | 'to'): string[] => ordered.flatMap((st) => (st[key] ? [st[key]!] : []))

  return analyzeXmlGrid(db, {
    fileName: input.fileName,
    accountId: input.accountId,
    grid: [HEADER, ...ordered.flatMap((st) => st.rows.map(gridRow))],
    mapping: MAPPING,
    xml: {
      balances: { opening: ordered[0]!.opening, closing: ordered.at(-1)!.closing },
      period: { from: dates('from').sort()[0] ?? null, to: dates('to').sort().at(-1) ?? null },
      notes
    }
  })
}
