/**
 * Transfers between the person's own accounts: money out of one and into another a few days apart.
 * Paired, both halves sit in a transfer category, so they count as neither income nor spending.
 *
 * Between accounts in different currencies the amounts differ: what arrives is the amount at that
 * day's exchange rate, minus what the bank keeps. That difference is the exchange cost. When the
 * pair is made, the outgoing half is split into the transfer and the cost (in a fees category), so
 * the cost counts as spending. The cost can be changed afterwards (setTransferCost).
 */
import { randomBytes } from 'node:crypto'
import type { TransferPair } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { listSplits, normIban, setSplits } from './finance'
import { convert } from './fx'

/** At most this many days between the two halves. */
const MAX_DAYS = 3
/**
 * Between currencies, without a known bank cost: what arrives may be up to 7% below the amount at
 * the day's rate (bank margins, fees) and 1% above it (a rate a day earlier or later).
 */
const LOW = 0.93
const HIGH = 1.01
/** With a known bank cost: what arrives may differ this much (as a share) from what is expected. */
const SPREAD = 0.015

interface Candidate {
  oid: number
  iid: number
  o_date: string
  i_date: string
  o_amount: number
  i_amount: number
  o_currency: string
  i_currency: string
  o_name: string
  i_name: string
  o_cp_iban: string | null
  i_cp_iban: string | null
  o_acc_iban: string | null
  i_acc_iban: string | null
  o_cost_pct: number | null
}

const SELECT = `SELECT o.id AS oid, i.id AS iid, o.booking_date AS o_date, i.booking_date AS i_date, o.amount_cents AS o_amount, i.amount_cents AS i_amount,
       o.currency AS o_currency, i.currency AS i_currency, oa.name AS o_name, ia.name AS i_name,
       o.counterparty_iban AS o_cp_iban, i.counterparty_iban AS i_cp_iban, oa.iban AS o_acc_iban, ia.iban AS i_acc_iban, oa.fx_cost_pct AS o_cost_pct
     FROM transactions o
     JOIN transactions i ON i.account_id <> o.account_id
       AND i.booking_date BETWEEN date(o.booking_date, '-${MAX_DAYS} days') AND date(o.booking_date, '+${MAX_DAYS} days')
     JOIN accounts oa ON oa.id = o.account_id JOIN accounts ia ON ia.id = i.account_id
     WHERE o.amount_cents < 0 AND o.transfer_pair IS NULL AND i.transfer_pair IS NULL`

/**
 * The exchange cost of money moved between currencies, in the outgoing account's currency: what
 * the amount was worth at the day's rate minus what arrived. With no rate, the bank's percentage
 * (if known). Never negative (a better rate than the reference is no cost).
 */
export function exchangeCost(db: Db, t: { outCents: number; outCurrency: string; inCents: number; inCurrency: string; date: string; costPct: number | null }): number | null {
  const sent = -t.outCents
  const worth = convert(db, sent, t.outCurrency, t.date, t.inCurrency)
  if (worth !== null) {
    const lostIn = worth - t.inCents
    const lostOut = convert(db, lostIn, t.inCurrency, t.date, t.outCurrency)
    return lostOut === null ? null : Math.max(0, Math.round(lostOut))
  }
  return t.costPct !== null ? Math.round((sent * t.costPct) / 100) : null
}

/** How closely the arriving amount fits the outgoing one; null when they can't be a transfer. Lower is closer. */
function fit(db: Db, r: Candidate, sure: boolean): number | null {
  if (r.o_currency === r.i_currency) return r.i_amount === -r.o_amount ? 0 : null
  if (r.i_amount <= 0) return null
  const worth = convert(db, -r.o_amount, r.o_currency, r.o_date, r.i_currency)
  // Without a rate the amounts can't be compared: only the account number can tell.
  if (worth === null || worth <= 0) return sure ? 1 : null
  const ratio = r.i_amount / worth
  if (r.o_cost_pct !== null) {
    const expected = 1 - r.o_cost_pct / 100
    return Math.abs(ratio - expected) <= SPREAD ? Math.abs(ratio - expected) : null
  }
  return ratio >= LOW && ratio <= HIGH ? Math.abs(1 - ratio) : null
}

/** Unpaired transfers, the surest first; each transaction is in at most one pair. `onlyIds` limits them to pairs with one of these. */
export function findTransfers(db: Db, opts: { onlyIds?: number[] } = {}): TransferPair[] {
  const rows = db.prepare(`${SELECT} AND (i.amount_cents = -o.amount_cents AND i.currency = o.currency OR i.currency <> o.currency AND i.amount_cents > 0)`).all() as Candidate[]
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null
  const scored = rows
    .filter((r) => !only || only.has(r.oid) || only.has(r.iid))
    .flatMap((r) => {
      // Sure when one side names the other account's number.
      const sure = (!!r.o_cp_iban && !!r.i_acc_iban && normIban(r.o_cp_iban) === normIban(r.i_acc_iban)) || (!!r.i_cp_iban && !!r.o_acc_iban && normIban(r.i_cp_iban) === normIban(r.o_acc_iban))
      const closeness = fit(db, r, sure)
      if (closeness === null) return []
      const days = Math.abs((Date.parse(r.i_date) - Date.parse(r.o_date)) / 86_400_000)
      return [{ r, sure, days, closeness }]
    })
    .sort((a, b) => Number(b.sure) - Number(a.sure) || a.closeness - b.closeness || a.days - b.days || a.r.oid - b.r.oid)
  const used = new Set<number>()
  const out: TransferPair[] = []
  for (const { r, sure, days } of scored) {
    if (used.has(r.oid) || used.has(r.iid)) continue
    used.add(r.oid)
    used.add(r.iid)
    const cross = r.o_currency !== r.i_currency
    out.push({
      outId: r.oid,
      inId: r.iid,
      date: r.o_date,
      amountCents: -r.o_amount,
      currency: r.o_currency,
      inAmountCents: r.i_amount,
      inCurrency: r.i_currency,
      costCents: cross ? exchangeCost(db, { outCents: r.o_amount, outCurrency: r.o_currency, inCents: r.i_amount, inCurrency: r.i_currency, date: r.o_date, costPct: r.o_cost_pct }) : null,
      fromAccount: r.o_name,
      toAccount: r.i_name,
      confidence: sure ? 'iban' : 'amount',
      days
    })
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

/** The starting "Fees & taxes" category in each language Kasboek has. */
const FEE_NAMES = ['fees & taxes', 'kosten en belastingen', 'frais et impôts', 'gebühren und steuern', 'comisiones e impuestos', 'comissões e impostos', 'tarifas e impostos']

/** Where exchange costs go: the fees category (by its starting name), else any expense category about costs or fees. */
export function costCategory(db: Db): number | null {
  const cats = db.prepare("SELECT id, name FROM categories WHERE kind = 'expense' AND archived = 0 ORDER BY sort_order, id").all() as { id: number; name: string }[]
  return cats.find((c) => FEE_NAMES.includes(c.name.toLowerCase()))?.id ?? cats.find((c) => /fee|cost|kost|frais|gebühr|comisi|comiss|tarifa|bank/i.test(c.name))?.id ?? null
}

/**
 * Books the exchange cost of a pair between currencies: the outgoing half becomes the transfer plus
 * the cost. 0 removes the cost again. Without a fees category, or for a pair in one currency,
 * nothing is booked.
 */
function bookCost(db: Db, outId: number, costCents: number): void {
  const o = db.prepare('SELECT amount_cents, transfer_pair FROM transactions WHERE id = ?').get(outId) as { amount_cents: number; transfer_pair: string | null } | undefined
  if (!o?.transfer_pair) return
  const cat = transferCategory(db, [outId])
  const fees = costCategory(db)
  const cost = Math.min(Math.max(0, Math.round(costCents)), -o.amount_cents - 1)
  if (!cost || !fees || !cat) {
    if (isCostSplit(db, outId)) setSplits(db, outId, [])
    return
  }
  setSplits(db, outId, [
    { categoryId: cat, amountCents: o.amount_cents + cost, note: null },
    { categoryId: fees, amountCents: -cost, note: 'Exchange cost' }
  ])
}

/** Whether a transaction's split is the transfer-plus-exchange-cost one Kasboek made. */
function isCostSplit(db: Db, id: number): boolean {
  const parts = listSplits(db, id)
  if (parts.length !== 2) return false
  const kinds = parts.map((p) => (p.categoryId === null ? null : (db.prepare('SELECT kind FROM categories WHERE id = ?').get(p.categoryId) as { kind: string } | undefined)?.kind))
  return kinds.includes('transfer')
}

/** `costCents`: between currencies, the exchange cost to book; left out (or null), it is worked out from the rate. */
export function pairTransfers(db: Db, pairs: { outId: number; inId: number; costCents?: number | null }[]): { paired: number } {
  let paired = 0
  const get = db.prepare('SELECT t.id, t.account_id, t.amount_cents, t.currency, t.booking_date, t.transfer_pair, a.fx_cost_pct FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?')
  const set = db.prepare(
    `UPDATE transactions SET transfer_pair = ?, category_id = CASE WHEN category_id IN (SELECT id FROM categories WHERE kind = 'transfer') THEN category_id ELSE ? END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
  type Row = { id: number; account_id: number; amount_cents: number; currency: string; booking_date: string; transfer_pair: string | null; fx_cost_pct: number | null }
  db.transaction(() => {
    for (const p of pairs) {
      const o = get.get(p.outId) as Row | undefined
      const i = get.get(p.inId) as Row | undefined
      if (!o || !i) throw new AppError('tx.not_found', 'That transaction no longer exists.')
      const cross = o.currency !== i.currency
      if (o.account_id === i.account_id || o.amount_cents >= 0 || i.amount_cents <= 0 || (!cross && o.amount_cents !== -i.amount_cents))
        throw new AppError('transfers.mismatch', 'A transfer needs money out of one account and the same amount (or, in another currency, its value) into another.')
      if (o.transfer_pair || i.transfer_pair) continue
      const key = randomBytes(8).toString('hex')
      const cat = transferCategory(db, [o.id, i.id])
      set.run(key, cat, o.id)
      set.run(key, cat, i.id)
      if (cross) {
        const cost = p.costCents ?? exchangeCost(db, { outCents: o.amount_cents, outCurrency: o.currency, inCents: i.amount_cents, inCurrency: i.currency, date: o.booking_date, costPct: o.fx_cost_pct })
        if (cost) bookCost(db, o.id, cost)
      }
      paired++
    }
  })()
  return { paired }
}

/**
 * Changes the exchange cost of a pair between currencies (e.g. the exact cost from the bank
 * statement), in the outgoing account's currency. Either half's id will do.
 */
export function setTransferCost(db: Db, id: number, costCents: number): { costCents: number } {
  const t = db.prepare('SELECT transfer_pair FROM transactions WHERE id = ?').get(id) as { transfer_pair: string | null } | undefined
  if (!t?.transfer_pair) throw new AppError('transfers.not_paired', 'This transaction isn’t paired as a transfer.')
  const halves = db.prepare('SELECT id, amount_cents, currency FROM transactions WHERE transfer_pair = ?').all(t.transfer_pair) as { id: number; amount_cents: number; currency: string }[]
  const out = halves.find((h) => h.amount_cents < 0)
  const inn = halves.find((h) => h.amount_cents > 0)
  if (!out || !inn || out.currency === inn.currency) throw new AppError('transfers.same_currency', 'Only a transfer between currencies has an exchange cost.')
  if (costCents >= -out.amount_cents) throw new AppError('transfers.cost_too_high', 'The cost must be less than the amount sent.')
  if (!costCategory(db)) throw new AppError('transfers.no_fee_category', 'Add an expense category for fees first; the cost is booked there.')
  db.transaction(() => bookCost(db, out.id, costCents))()
  return { costCents: Math.max(0, Math.round(costCents)) }
}

/** The exchange cost booked on a pair (outgoing account's currency), or null when there is none. */
export function transferCost(db: Db, id: number): number | null {
  const t = db.prepare('SELECT transfer_pair FROM transactions WHERE id = ?').get(id) as { transfer_pair: string | null } | undefined
  if (!t?.transfer_pair) return null
  const out = db.prepare('SELECT id FROM transactions WHERE transfer_pair = ? AND amount_cents < 0').get(t.transfer_pair) as { id: number } | undefined
  if (!out || !isCostSplit(db, out.id)) return null
  const fees = listSplits(db, out.id).find((p) => p.note === 'Exchange cost' || (p.categoryId !== null && p.categoryId === costCategory(db)))
  return fees ? -fees.amountCents : null
}

/** For the transaction window: whether a pair is between currencies, and its cost in the sending currency. */
export function transferCostInfo(db: Db, id: number): { cross: boolean; currency: string | null; costCents: number | null } {
  const t = db.prepare('SELECT transfer_pair FROM transactions WHERE id = ?').get(id) as { transfer_pair: string | null } | undefined
  if (!t?.transfer_pair) return { cross: false, currency: null, costCents: null }
  const halves = db.prepare('SELECT amount_cents, currency FROM transactions WHERE transfer_pair = ?').all(t.transfer_pair) as { amount_cents: number; currency: string }[]
  const out = halves.find((h) => h.amount_cents < 0)
  const cross = new Set(halves.map((h) => h.currency)).size > 1
  return { cross, currency: out?.currency ?? null, costCents: cross ? transferCost(db, id) : null }
}

/** Separates the two halves again (their categories stay as they are; a booked exchange cost is removed). */
export function unpairTransfer(db: Db, id: number): void {
  const t = db.prepare('SELECT transfer_pair FROM transactions WHERE id = ?').get(id) as { transfer_pair: string | null } | undefined
  if (!t?.transfer_pair) return
  db.transaction(() => {
    const halves = db.prepare('SELECT id FROM transactions WHERE transfer_pair = ?').all(t.transfer_pair) as { id: number }[]
    for (const h of halves) if (isCostSplit(db, h.id)) setSplits(db, h.id, [])
    db.prepare("UPDATE transactions SET transfer_pair = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE transfer_pair = ?").run(t.transfer_pair)
  })()
}
