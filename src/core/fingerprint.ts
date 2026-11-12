import { createHash } from 'node:crypto'

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Identifies "the same transaction" across imports: same account, date, amount,
 * counterparty and description (and bank reference when there is one).
 * Not unique on purpose: two identical coffees on one day are both real.
 */
export function fingerprint(t: {
  accountId: number
  bookingDate: string
  amountCents: number
  counterpartyName?: string | null
  description?: string | null
  bankReference?: string | null
}): string {
  return createHash('sha256')
    .update([t.accountId, t.bookingDate, t.amountCents, norm(t.counterpartyName), norm(t.description), norm(t.bankReference)].join('|'))
    .digest('hex')
    .slice(0, 32)
}
