/** Transactions, categories, rules, budgets and monthly summaries. */
import { addMonths, monthRange } from '@shared/month'
import type { BudgetRow, MonthSummary, Rule, RuleField, RuleMatch, RulePreview, Transaction, TransactionPage } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { fingerprint } from './fingerprint'
import { getSettings } from './settings'
import { currentBalance } from './balance'

/** A transaction's amount in currency `to` (SQL parameter by default), NULL when there is no rate. */
const FX = (to = '?'): string => `fx(t.amount_cents, t.currency, t.booking_date, ${to})`
const mainCurrency = (db: Db): string => getSettings(db).currency

/* ---------- Transactions ---------- */

interface TxRow {
  id: number
  account_id: number
  account_name: string
  booking_date: string
  value_date: string | null
  amount_cents: number
  currency: string
  description: string
  counterparty_name: string | null
  counterparty_iban: string | null
  communication: string | null
  category_id: number | null
  category_name: string | null
  notes: string | null
  import_batch_id: number | null
}

const toTx = (r: TxRow): Transaction => ({
  id: r.id,
  accountId: r.account_id,
  accountName: r.account_name,
  bookingDate: r.booking_date,
  valueDate: r.value_date,
  amountCents: r.amount_cents,
  currency: r.currency,
  description: r.description,
  counterpartyName: r.counterparty_name,
  counterpartyIban: r.counterparty_iban,
  communication: r.communication,
  categoryId: r.category_id,
  categoryName: r.category_name,
  notes: r.notes,
  importBatchId: r.import_batch_id
})

const TX_SELECT = `SELECT t.*, a.name AS account_name, c.name AS category_name
  FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id`

export interface TxFilter {
  accountId?: number
  categoryId?: number | 'none'
  month?: string
  from?: string
  to?: string
  search?: string
  direction?: 'in' | 'out'
  limit: number
  offset: number
}

export function listTransactions(db: Db, f: TxFilter): TransactionPage {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.accountId) where.push('t.account_id = ?') && args.push(f.accountId)
  if (f.categoryId === 'none') where.push('t.category_id IS NULL')
  else if (f.categoryId) where.push('t.category_id = ?') && args.push(f.categoryId)
  if (f.month) {
    const r = monthRange(f.month)
    where.push('t.booking_date >= ? AND t.booking_date < ?')
    args.push(r.from, r.to)
  }
  if (f.from) where.push('t.booking_date >= ?') && args.push(f.from)
  if (f.to) where.push('t.booking_date <= ?') && args.push(f.to)
  if (f.direction === 'in') where.push('t.amount_cents > 0')
  if (f.direction === 'out') where.push('t.amount_cents < 0')
  if (f.search?.trim()) {
    const q = `%${f.search.trim().replace(/[%_\\]/g, (m) => '\\' + m)}%`
    where.push(`(t.description LIKE ? ESCAPE '\\' OR t.counterparty_name LIKE ? ESCAPE '\\' OR t.communication LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`)
    args.push(q, q, q, q)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const items = (db.prepare(`${TX_SELECT} ${w} ORDER BY t.booking_date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset) as TxRow[]).map(toTx)
  const agg = db
    .prepare(
      `SELECT count(*) AS n, coalesce(sum(CASE WHEN amount_cents > 0 THEN ${FX()} END), 0) AS inc,
              coalesce(sum(CASE WHEN amount_cents < 0 THEN ${FX()} END), 0) AS outc
       FROM transactions t ${w}`
    )
    .get(mainCurrency(db), mainCurrency(db), ...args) as { n: number; inc: number; outc: number }
  return { items, total: agg.n, inCents: agg.inc, outCents: -agg.outc }
}

export function getTransaction(db: Db, id: number): Transaction {
  const row = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as TxRow | undefined
  if (!row) throw new AppError('tx.not_found', 'That transaction no longer exists.')
  return toTx(row)
}

function requireAccount(db: Db, id: number): void {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw new AppError('accounts.not_found', 'Account not found.')
}

function requireCategory(db: Db, id: number | null | undefined): void {
  if (id == null) return
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw new AppError('categories.not_found', 'Category not found.')
}

export interface NewTx {
  accountId: number
  bookingDate: string
  valueDate?: string | null
  amountCents: number
  currency?: string
  description: string
  counterpartyName?: string | null
  counterpartyIban?: string | null
  communication?: string | null
  categoryId?: number | null
  notes?: string | null
  bankReference?: string | null
  importBatchId?: number | null
  /** Set by imports: computed from the bank's own text, not the cleaned-up one. */
  fingerprint?: string
  /** The bank's own text, when the readable one was tidied (defaults to the readable one). */
  bankCounterparty?: string | null
  bankDescription?: string
}

/** `rules` can be passed in when inserting many rows, so they are read once. */
export function insertTransaction(db: Db, t: NewTx, rules?: Rule[]): number {
  const categoryId = t.categoryId ?? matchRule(db, t, rules)?.categoryId ?? null
  const r = db
    .prepare(
      `INSERT INTO transactions (account_id, booking_date, value_date, amount_cents, currency, description, counterparty_name,
         counterparty_iban, communication, category_id, notes, import_batch_id, bank_reference, fingerprint, bank_counterparty, bank_description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.accountId,
      t.bookingDate,
      t.valueDate ?? null,
      t.amountCents,
      t.currency ?? (db.prepare('SELECT currency FROM accounts WHERE id = ?').get(t.accountId) as { currency: string } | undefined)?.currency ?? 'EUR',
      t.description,
      t.counterpartyName ?? null,
      t.counterpartyIban ?? null,
      t.communication ?? null,
      categoryId,
      t.notes ?? null,
      t.importBatchId ?? null,
      t.bankReference ?? null,
      t.fingerprint ?? fingerprint(t),
      t.bankCounterparty !== undefined ? t.bankCounterparty : (t.counterpartyName ?? null),
      t.bankDescription ?? t.description
    )
  return Number(r.lastInsertRowid)
}

export function createTransaction(db: Db, t: NewTx): Transaction {
  requireAccount(db, t.accountId)
  requireCategory(db, t.categoryId)
  return getTransaction(db, insertTransaction(db, t))
}

export function updateTransaction(
  db: Db,
  input: { id: number; categoryId?: number | null; notes?: string | null; description?: string; bookingDate?: string; amountCents?: number; counterpartyName?: string | null }
): Transaction {
  const current = getTransaction(db, input.id)
  requireCategory(db, input.categoryId)
  const next = {
    category_id: input.categoryId !== undefined ? input.categoryId : current.categoryId,
    notes: input.notes !== undefined ? input.notes : current.notes,
    description: input.description ?? current.description,
    booking_date: input.bookingDate ?? current.bookingDate,
    amount_cents: input.amountCents ?? current.amountCents,
    counterparty_name: input.counterpartyName !== undefined ? input.counterpartyName : current.counterpartyName
  }
  db.prepare(
    `UPDATE transactions SET category_id = @category_id, notes = @notes, description = @description, booking_date = @booking_date,
       amount_cents = @amount_cents, counterparty_name = @counterparty_name, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
  ).run({ ...next, id: input.id })
  return getTransaction(db, input.id)
}

/** `onlyUncategorised`: leaves transactions that got a category meanwhile as they are. */
export function categorizeTransactions(db: Db, ids: number[], categoryId: number | null, opts: { onlyUncategorised?: boolean } = {}): { updated: number } {
  requireCategory(db, categoryId)
  const stmt = db.prepare(`UPDATE transactions SET category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?${opts.onlyUncategorised ? ' AND category_id IS NULL' : ''}`)
  let updated = 0
  db.transaction(() => ids.forEach((id) => (updated += stmt.run(categoryId, id).changes)))()
  return { updated }
}

export function deleteTransactions(db: Db, ids: number[]): { deleted: number } {
  const stmt = db.prepare('DELETE FROM transactions WHERE id = ?')
  let deleted = 0
  db.transaction(() => ids.forEach((id) => (deleted += stmt.run(id).changes)))()
  return { deleted }
}

/* ---------- Categories ---------- */

export function createCategory(db: Db, input: { name: string; kind: 'expense' | 'income' | 'transfer' }): number {
  try {
    const max = (db.prepare('SELECT coalesce(max(sort_order), 0) AS m FROM categories').get() as { m: number }).m
    return Number(db.prepare('INSERT INTO categories (name, kind, sort_order) VALUES (?, ?, ?)').run(input.name, input.kind, max + 1).lastInsertRowid)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new AppError('categories.duplicate', 'A category with this name already exists.')
    throw err
  }
}

export function updateCategory(db: Db, input: { id: number; name?: string; archived?: boolean }): void {
  requireCategory(db, input.id)
  try {
    if (input.name !== undefined) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(input.name, input.id)
    if (input.archived !== undefined) db.prepare('UPDATE categories SET archived = ? WHERE id = ?').run(input.archived ? 1 : 0, input.id)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new AppError('categories.duplicate', 'A category with this name already exists.')
    throw err
  }
}

/* ---------- Rules ---------- */

interface RuleRow {
  id: number
  field: RuleField
  match: RuleMatch
  pattern: string
  category_id: number
  category_name: string
  priority: number
}

/** Short texts match too much anywhere ("Q8" inside a reference), so they only match whole words. */
const SHORT_PATTERN = 4

export function listRules(db: Db): Rule[] {
  return (
    db
      .prepare(
        `SELECT r.*, c.name AS category_name FROM rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.priority DESC, r.field = 'counterparty' DESC, length(r.pattern) DESC, r.id`
      )
      .all() as RuleRow[]
  ).map((r) => ({ id: r.id, field: r.field, match: r.match ?? 'contains', pattern: r.pattern, categoryId: r.category_id, categoryName: r.category_name, priority: r.priority ?? 0 }))
}

const fold = (s: string | null | undefined): string => (s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim()
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordCache = new Map<string, RegExp>()

/** Whether one text matches a rule's pattern (case- and accent-insensitive). */
export function textMatches(text: string, pattern: string, match: RuleMatch): boolean {
  const t = fold(text)
  const p = fold(pattern)
  if (!p) return false
  if (match === 'starts') return t.startsWith(p)
  if (match === 'word') {
    let re = wordCache.get(p)
    if (!re) {
      re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(p)}(?:$|[^\\p{L}\\p{N}])`, 'u')
      if (wordCache.size > 500) wordCache.clear()
      wordCache.set(p, re)
    }
    return re.test(t)
  }
  return t.includes(p)
}

/** What a rule looks at: the readable text and the bank's own text (and the counterparty's IBAN). */
export interface RuleText {
  counterpartyName?: string | null
  description?: string | null
  bankCounterparty?: string | null
  bankDescription?: string | null
  counterpartyIban?: string | null
}

export const normIban = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase()

export function ruleMatches(r: Pick<Rule, 'field' | 'pattern' | 'match'>, t: RuleText): boolean {
  if (r.field === 'iban') return !!t.counterpartyIban && normIban(t.counterpartyIban) === normIban(r.pattern)
  const any = (...texts: (string | null | undefined)[]): boolean => texts.some((x) => !!x && textMatches(x, r.pattern, r.match))
  if (r.field !== 'description' && any(t.counterpartyName, t.bankCounterparty)) return true
  return r.field !== 'counterparty' && any(t.description, t.bankDescription)
}

/** Columns a rule needs, for SQL that reads transactions to match rules against. */
export const RULE_COLUMNS = 'counterparty_name, description, bank_counterparty, bank_description, counterparty_iban'
export const ruleText = (r: { counterparty_name: string | null; description: string; bank_counterparty: string | null; bank_description: string | null; counterparty_iban: string | null }): RuleText => ({
  counterpartyName: r.counterparty_name,
  description: r.description,
  bankCounterparty: r.bank_counterparty,
  bankDescription: r.bank_description,
  counterpartyIban: r.counterparty_iban
})
type RuleRowText = Parameters<typeof ruleText>[0]

/** The first matching rule in rule order (priority, then counterparty rules, then the longest text). */
export function matchRule(db: Db, t: RuleText, rules = listRules(db)): Rule | undefined {
  return rules.find((r) => ruleMatches(r, t))
}

/** A short "contains" text becomes a whole-word rule. */
function effectiveMatch(pattern: string, match: RuleMatch | undefined, field?: RuleField): RuleMatch {
  const m = match ?? 'contains'
  if (field === 'iban') return 'contains'
  return m === 'contains' && pattern.trim().length < SHORT_PATTERN ? 'word' : m
}

export function previewRule(db: Db, input: { field: RuleField; pattern: string; match?: RuleMatch; categoryId?: number | null }): RulePreview {
  const match = effectiveMatch(input.pattern, input.match, input.field)
  const rule = { field: input.field, pattern: input.pattern.trim(), match }
  const rows = db.prepare(`SELECT ${RULE_COLUMNS}, category_id FROM transactions`).all() as (RuleRowText & { category_id: number | null })[]
  const hits = rows.filter((r) => ruleMatches(rule, ruleText(r)))
  const examples = [...new Set(hits.map((h) => h.counterparty_name || h.description))].slice(0, 3).map((e) => e.slice(0, 60))
  return {
    matches: hits.length,
    uncategorised: hits.filter((h) => h.category_id === null).length,
    otherCategory: hits.filter((h) => h.category_id !== null && h.category_id !== input.categoryId).length,
    wholeWord: input.field !== 'iban' && match !== (input.match ?? 'contains'),
    examples
  }
}

function applyRule(db: Db, rule: Rule): number {
  const rows = db.prepare(`SELECT id, ${RULE_COLUMNS} FROM transactions WHERE category_id IS NULL`).all() as (RuleRowText & { id: number })[]
  const hits = rows.filter((r) => ruleMatches(rule, ruleText(r))).map((r) => r.id)
  return hits.length ? categorizeTransactions(db, hits, rule.categoryId).updated : 0
}

export function createRule(db: Db, input: { field: RuleField; pattern: string; match?: RuleMatch; categoryId: number; applyToExisting: boolean }): { rule: Rule; applied: number } {
  requireCategory(db, input.categoryId)
  const pattern = input.field === 'iban' ? normIban(input.pattern) : input.pattern.trim()
  let id: number
  try {
    id = Number(db.prepare('INSERT INTO rules (field, pattern, match, category_id) VALUES (?, ?, ?, ?)').run(input.field, pattern, effectiveMatch(pattern, input.match, input.field), input.categoryId).lastInsertRowid)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new AppError('rules.duplicate', 'A rule for this text already exists.')
    throw err
  }
  const rule = listRules(db).find((r) => r.id === id)!
  return { rule, applied: input.applyToExisting ? applyRule(db, rule) : 0 }
}

export function updateRule(
  db: Db,
  input: { id: number; field?: RuleField; pattern?: string; match?: RuleMatch; categoryId?: number; applyToExisting?: boolean }
): { rule: Rule; applied: number } {
  const old = listRules(db).find((r) => r.id === input.id)
  if (!old) throw new AppError('rules.not_found', 'That rule no longer exists.')
  if (input.categoryId !== undefined) requireCategory(db, input.categoryId)
  const field = input.field ?? old.field
  const pattern = input.pattern === undefined ? old.pattern : field === 'iban' ? normIban(input.pattern) : input.pattern.trim()
  const match = effectiveMatch(pattern, input.match ?? old.match, field)
  try {
    db.prepare('UPDATE rules SET field = ?, pattern = ?, match = ?, category_id = ? WHERE id = ?').run(field, pattern, match, input.categoryId ?? old.categoryId, input.id)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new AppError('rules.duplicate', 'A rule for this text already exists.')
    throw err
  }
  const rule = listRules(db).find((r) => r.id === input.id)!
  return { rule, applied: input.applyToExisting ? applyRule(db, rule) : 0 }
}

/** Puts the rules in this order (first = checked first). Rules not listed keep their place after them. */
export function reorderRules(db: Db, ids: number[]): Rule[] {
  const set = db.prepare('UPDATE rules SET priority = ? WHERE id = ?')
  db.transaction(() => {
    const rest = listRules(db).filter((r) => !ids.includes(r.id))
    const order = [...ids, ...rest.map((r) => r.id)]
    order.forEach((id, i) => set.run(order.length - i, id))
  })()
  return listRules(db)
}

export function deleteRule(db: Db, id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id)
}

/* ---------- Budgets & summaries ---------- */

/** Spending per category for a month: money out minus refunds, transfers excluded. */
function spentByCategory(db: Db, month: string): Map<number | null, number> {
  const r = monthRange(month)
  const rows = db
    .prepare(
      `SELECT t.category_id AS id, -coalesce(sum(${FX()}), 0) AS spent FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.booking_date >= ? AND t.booking_date < ? AND (c.kind IS NULL OR c.kind = 'expense')
         AND (t.amount_cents < 0 OR c.kind = 'expense')
       GROUP BY t.category_id`
    )
    .all(mainCurrency(db), r.from, r.to) as { id: number | null; spent: number }[]
  return new Map(rows.map((x) => [x.id, x.spent]))
}

export function listBudgets(db: Db, month: string): BudgetRow[] {
  const spent = spentByCategory(db, month)
  const rows = db
    .prepare(
      `SELECT c.id, c.name, b.amount_cents FROM categories c LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
       WHERE c.kind = 'expense' AND (c.archived = 0 OR b.amount_cents IS NOT NULL) ORDER BY c.sort_order, c.name`
    )
    .all(month) as { id: number; name: string; amount_cents: number | null }[]
  return rows.map((r) => ({ categoryId: r.id, name: r.name, budgetCents: r.amount_cents, spentCents: spent.get(r.id) ?? 0 }))
}

export function setBudget(db: Db, input: { categoryId: number; month: string; amountCents: number | null }): BudgetRow[] {
  const kind = (db.prepare('SELECT kind FROM categories WHERE id = ?').get(input.categoryId) as { kind: string } | undefined)?.kind
  if (kind !== 'expense') throw new AppError('budgets.not_expense', 'Budgets can only be set for spending categories.')
  if (input.amountCents === null) db.prepare('DELETE FROM budgets WHERE category_id = ? AND month = ?').run(input.categoryId, input.month)
  else
    db.prepare(
      'INSERT INTO budgets (category_id, month, amount_cents) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET amount_cents = excluded.amount_cents'
    ).run(input.categoryId, input.month, input.amountCents)
  return listBudgets(db, input.month)
}

export function copyBudgets(db: Db, month: string): { copied: number } {
  const r = db
    .prepare(
      `INSERT INTO budgets (category_id, month, amount_cents) SELECT category_id, ?, amount_cents FROM budgets WHERE month = ?
       ON CONFLICT(category_id, month) DO NOTHING`
    )
    .run(month, addMonths(month, -1))
  return { copied: r.changes }
}

function incomeAndSpending(db: Db, month: string): { incomeCents: number; spendingCents: number } {
  const r = monthRange(month)
  const row = db
    .prepare(
      `SELECT coalesce(sum(CASE WHEN t.amount_cents > 0 THEN ${FX()} END), 0) AS inc,
              coalesce(-sum(CASE WHEN t.amount_cents < 0 THEN ${FX()} END), 0) AS spend
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.booking_date >= ? AND t.booking_date < ? AND (c.kind IS NULL OR c.kind != 'transfer')`
    )
    .get(mainCurrency(db), mainCurrency(db), r.from, r.to) as { inc: number; spend: number }
  return { incomeCents: row.inc, spendingCents: row.spend }
}

export function monthSummary(db: Db, month: string): MonthSummary {
  const { incomeCents, spendingCents } = incomeAndSpending(db, month)
  const budgets = listBudgets(db, month)
  const budgeted = budgets.filter((b) => b.budgetCents !== null)
  const budgetedCents = budgeted.reduce((s, b) => s + (b.budgetCents ?? 0), 0)
  const spentOnBudgeted = budgeted.reduce((s, b) => s + b.spentCents, 0)
  const names = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]))
  const byCategory = [...spentByCategory(db, month).entries()]
    .filter(([, cents]) => cents > 0)
    .map(([id, cents]) => ({ categoryId: id, name: id === null ? '' : (names.get(id) ?? ''), cents }))
    .sort((a, b) => b.cents - a.cents)
  const r = monthRange(month)
  const uncategorized = (db.prepare('SELECT count(*) AS n FROM transactions WHERE category_id IS NULL AND booking_date >= ? AND booking_date < ?').get(r.from, r.to) as { n: number }).n
  const unconverted = (db.prepare(`SELECT count(*) AS n FROM transactions t WHERE t.booking_date >= ? AND t.booking_date < ? AND ${FX()} IS NULL`).get(r.from, r.to, mainCurrency(db)) as { n: number }).n
  const history = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5)).map((m) => ({ month: m, ...incomeAndSpending(db, m) }))
  return {
    month,
    incomeCents,
    spendingCents,
    budgetedCents,
    leftCents: budgeted.length ? budgetedCents - spentOnBudgeted : null,
    byCategory,
    uncategorized,
    unconverted,
    history
  }
}

/**
 * Balance per account in the account's own currency (a transaction in another currency is
 * converted at its date's rate), and that balance in the main currency at today's rate.
 */
export function accountBalances(db: Db, today = new Date().toISOString().slice(0, 10)): Map<number, { balance: number; balanceMain: number | null; count: number }> {
  const rows = db
    .prepare(
      `SELECT a.id, a.currency, a.opening_balance_cents + coalesce(sum(${FX('a.currency')}), 0) AS bal, count(t.id) AS n,
         EXISTS (SELECT 1 FROM valuations v WHERE v.account_id = a.id) AS checked
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id`
    )
    .all() as { id: number; currency: string; bal: number; n: number; checked: number }[]
  const main = mainCurrency(db)
  return new Map(
    rows.map((r) => {
      // With a recorded bank balance (or value), that is the starting point.
      const balance = r.checked ? currentBalance(db, r.id) : r.bal
      return [r.id, { balance, balanceMain: (db.prepare('SELECT fx(?, ?, ?, ?) AS v').get(balance, r.currency, today, main) as { v: number | null }).v, count: r.n }]
    })
  )
}

/** Renames the starting categories (still under their English names) for a new database. */
export function localizeDefaultCategories(db: Db, names: Record<string, string>): void {
  const rename = db.prepare('UPDATE categories SET name = ? WHERE name = ? AND NOT EXISTS (SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE)')
  db.transaction(() => {
    for (const [en, local] of Object.entries(names)) if (local && local !== en) rename.run(local, en, local)
  })()
}
