/**
 * Transfers between the person's own accounts: money out of one and the same amount into another a
 * few days apart. Paired, both halves sit in a transfer category, so they count as neither income
 * nor spending.
 */
import { randomBytes } from 'node:crypto'
import type { TransferPair } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { normIban } from './finance'

/** At most this many days between the two halves. */
const MAX_DAYS = 3

interface Candidate {
  oid: number
  iid: number
  o_date: string
  i_date: string
  amount: number
  currency: string
  o_account: number
  i_account: number
  o_name: string
  i_name: string
  o_cp_iban: string | null
  i_cp_iban: string | null
  o_acc_iban: string | null
  i_acc_iban: string | null
}

/** Unpaired transfers, the surest first; each transaction is in at most one pair. `onlyIds` limits them to pairs with one of these. */
export function findTransfers(db: Db, opts: { onlyIds?: number[] } = {}): TransferPair[] {
  const rows = db
    .prepare(
      `SELECT o.id AS oid, i.id AS iid, o.booking_date AS o_date, i.booking_date AS i_date, -o.amount_cents AS amount, o.currency,
              o.account_id AS o_account, i.account_id AS i_account, oa.name AS o_name, ia.name AS i_name,
              o.counterparty_iban AS o_cp_iban, i.counterparty_iban AS i_cp_iban, oa.iban AS o_acc_iban, ia.iban AS i_acc_iban
       FROM transactions o
       JOIN transactions i ON i.amount_cents = -o.amount_cents AND i.account_id <> o.account_id AND i.currency = o.currency
         AND i.booking_date BETWEEN date(o.booking_date, '-${MAX_DAYS} days') AND date(o.booking_date, '+${MAX_DAYS} days')
       JOIN accounts oa ON oa.id = o.account_id JOIN accounts ia ON ia.id = i.account_id
       WHERE o.amount_cents < 0 AND o.transfer_pair IS NULL AND i.transfer_pair IS NULL`
    )
    .all() as Candidate[]
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null
  const scored = rows
    .filter((r) => !only || only.has(r.oid) || only.has(r.iid))
    .map((r) => {
      // Sure when one side names the other account's number.
      const sure = (!!r.o_cp_iban && !!r.i_acc_iban && normIban(r.o_cp_iban) === normIban(r.i_acc_iban)) || (!!r.i_cp_iban && !!r.o_acc_iban && normIban(r.i_cp_iban) === normIban(r.o_acc_iban))
      const days = Math.abs((Date.parse(r.i_date) - Date.parse(r.o_date)) / 86_400_000)
      return { r, sure, days }
    })
    .sort((a, b) => Number(b.sure) - Number(a.sure) || a.days - b.days || a.r.oid - b.r.oid)
  const used = new Set<number>()
  const out: TransferPair[] = []
  for (const { r, sure, days } of scored) {
    if (used.has(r.oid) || used.has(r.iid)) continue
    used.add(r.oid)
    used.add(r.iid)
    out.push({ outId: r.oid, inId: r.iid, date: r.o_date, amountCents: r.amount, currency: r.currency, fromAccount: r.o_name, toAccount: r.i_name, confidence: sure ? 'iban' : 'amount', days })
  }
  return out
}

/** The transfer category for a pair: one of the halves already has, else the first one. */
function transferCategory(db: Db, ids: number[]): number | null {
  const own = db
    .prepare(`SELECT c.id FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id IN (${ids.map(() => '?').join(',')}) AND c.kind = 'transfer' LIMIT 1`)
    .get(...ids) as { id: number } | undefined
  if (own) return own.id
  return (db.prepare("SELECT id FROM categories WHERE kind = 'transfer' AND archived = 0 ORDER BY sort_order, id LIMIT 1").get() as { id: number } | undefined)?.id ?? null
}

export function pairTransfers(db: Db, pairs: { outId: number; inId: number }[]): { paired: number } {
  let paired = 0
  const get = db.prepare('SELECT id, account_id, amount_cents, transfer_pair FROM transactions WHERE id = ?')
  const set = db.prepare(
    `UPDATE transactions SET transfer_pair = ?, category_id = CASE WHEN category_id IN (SELECT id FROM categories WHERE kind = 'transfer') THEN category_id ELSE ? END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
  db.transaction(() => {
    for (const p of pairs) {
      const o = get.get(p.outId) as { id: number; account_id: number; amount_cents: number; transfer_pair: string | null } | undefined
      const i = get.get(p.inId) as typeof o
      if (!o || !i) throw new AppError('tx.not_found', 'That transaction no longer exists.')
      if (o.account_id === i.account_id || o.amount_cents !== -i.amount_cents) throw new AppError('transfers.mismatch', 'A transfer needs the same amount out of one account and into another.')
      if (o.transfer_pair || i.transfer_pair) continue
      const key = randomBytes(8).toString('hex')
      const cat = transferCategory(db, [o.id, i.id])
      set.run(key, cat, o.id)
      set.run(key, cat, i.id)
      paired++
    }
  })()
  return { paired }
}

/** Separates the two halves again (their categories stay as they are). */
export function unpairTransfer(db: Db, id: number): void {
  const t = db.prepare('SELECT transfer_pair FROM transactions WHERE id = ?').get(id) as { transfer_pair: string | null } | undefined
  if (!t?.transfer_pair) return
  db.prepare("UPDATE transactions SET transfer_pair = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE transfer_pair = ?").run(t.transfer_pair)
}
