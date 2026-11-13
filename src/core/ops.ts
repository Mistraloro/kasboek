import { z } from 'zod'
import { contract, type OpName, type OpOutput, type OpParsedInput, type OpResult } from '@shared/contract'
import type { Account, AccountWithBalance, Actor, Category, FxStatus } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { getSettings, updateSettings } from './settings'
import * as fin from './finance'
import * as imp from './import'
import * as fx from './fx'

export function fxStatus(db: Db): FxStatus {
  const s = getSettings(db)
  return { main: s.currency, currencies: fx.currencyInfo(db, s.currency), lastEcbUpdateAt: s.fxLastEcbUpdateAt, autoUpdate: s.fxAutoUpdate }
}

export interface OpContext {
  db: Db
  actor: Actor
}

export interface OpDef<K extends OpName> {
  handler: (ctx: OpContext, input: OpParsedInput<K>) => OpOutput<K> | Promise<OpOutput<K>>
  /** Writes to the database. Mutating calls are recorded in the audit log. */
  mutates: boolean
  /** Offered to Claude as a tool (Phase 4). Desktop-only actions like file dialogs are not. */
  assistant: boolean
}

export type OpTable = { [K in OpName]?: OpDef<K> }

interface AccountRow {
  id: number
  name: string
  bank: string
  iban: string | null
  currency: string
  opening_balance_cents: number
  archived: number
  created_at: string
}

interface CategoryRow {
  id: number
  name: string
  kind: Category['kind']
  parent_id: number | null
  color: string | null
  sort_order: number
  archived: number
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  name: r.name,
  bank: r.bank,
  iban: r.iban,
  currency: r.currency,
  openingBalanceCents: r.opening_balance_cents,
  archived: r.archived === 1,
  createdAt: r.created_at
})

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  parentId: r.parent_id,
  color: r.color,
  sortOrder: r.sort_order,
  archived: r.archived === 1
})

/** Removes spaces and upper-cases an IBAN, e.g. `be68 5390 0754 7034` → `BE68539007547034`. */
export function normalizeIban(iban: string | null | undefined): string | null {
  if (!iban) return null
  const v = iban.replace(/\s+/g, '').toUpperCase()
  return v.length ? v : null
}

export const coreOps: OpTable = {
  'settings.get': {
    mutates: false,
    assistant: true,
    handler: ({ db }) => getSettings(db)
  },
  'settings.update': {
    mutates: true,
    assistant: false,
    handler: ({ db }, patch) => updateSettings(db, patch)
  },
  'fx.status': { mutates: false, assistant: true, handler: ({ db }) => fxStatus(db) },
  'fx.rates': { mutates: false, assistant: true, handler: ({ db }, input) => fx.listManualRates(db, input.currency) },
  'fx.setRate': {
    mutates: true,
    assistant: true,
    handler: ({ db }, input) => {
      fx.setManualRate(db, input)
      return fxStatus(db)
    }
  },
  'fx.deleteRate': {
    mutates: true,
    assistant: false,
    handler: ({ db }, input) => {
      fx.deleteManualRate(db, input)
      return fxStatus(db)
    }
  },
  'accounts.list': {
    mutates: false,
    assistant: true,
    handler: ({ db }): AccountWithBalance[] => {
      const bal = fin.accountBalances(db)
      return (db.prepare('SELECT * FROM accounts ORDER BY archived, name').all() as AccountRow[]).map((r) => ({
        ...toAccount(r),
        balanceCents: bal.get(r.id)?.balance ?? r.opening_balance_cents,
        balanceMainCents: bal.get(r.id)?.balanceMain ?? null,
        transactionCount: bal.get(r.id)?.count ?? 0
      }))
    }
  },
  'accounts.update': {
    mutates: true,
    assistant: false,
    handler: ({ db }, input) => {
      const cur = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.id) as AccountRow | undefined
      if (!cur) throw new AppError('accounts.not_found', 'Account not found.')
      db.transaction(() => {
        db.prepare('UPDATE accounts SET name = ?, bank = ?, iban = ?, currency = ?, archived = ? WHERE id = ?').run(
          input.name ?? cur.name,
          input.bank ?? cur.bank,
          input.iban !== undefined ? normalizeIban(input.iban) : cur.iban,
          input.currency ?? cur.currency,
          input.archived !== undefined ? (input.archived ? 1 : 0) : cur.archived,
          input.id
        )
        // Changing the currency corrects it: amounts that were in the old one now count in the new one.
        if (input.currency && input.currency !== cur.currency)
          db.prepare('UPDATE transactions SET currency = ? WHERE account_id = ? AND currency = ?').run(input.currency, input.id, cur.currency)
      })()
      return toAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.id) as AccountRow)
    }
  },
  'accounts.create': {
    mutates: true,
    assistant: true,
    handler: ({ db }, input) => {
      const iban = normalizeIban(input.iban)
      try {
        const row = db
          .prepare(
            `INSERT INTO accounts (name, bank, iban, currency, opening_balance_cents)
             VALUES (?, ?, ?, ?, ?) RETURNING *`
          )
          .get(input.name, input.bank, iban, input.currency.toUpperCase(), input.openingBalanceCents) as AccountRow
        return toAccount(row)
      } catch (err) {
        if (err instanceof Error && /UNIQUE/.test(err.message)) {
          throw new AppError('accounts.duplicate_iban', 'An account with this IBAN already exists.')
        }
        throw err
      }
    }
  },
  'categories.list': { mutates: false, assistant: true, handler: ({ db }) => listCategories(db) },
  'categories.create': {
    mutates: true,
    assistant: true,
    handler: ({ db }, input) => {
      fin.createCategory(db, input)
      return listCategories(db)
    }
  },
  'categories.update': {
    mutates: true,
    assistant: false,
    handler: ({ db }, input) => {
      fin.updateCategory(db, input)
      return listCategories(db)
    }
  },

  'transactions.list': { mutates: false, assistant: true, handler: ({ db }, f) => fin.listTransactions(db, f) },
  'transactions.create': { mutates: true, assistant: false, handler: ({ db }, t) => fin.createTransaction(db, t) },
  'transactions.update': { mutates: true, assistant: false, handler: ({ db }, t) => fin.updateTransaction(db, t) },
  'transactions.categorize': { mutates: true, assistant: true, handler: ({ db }, i) => fin.categorizeTransactions(db, i.ids, i.categoryId) },
  'transactions.delete': { mutates: true, assistant: false, handler: ({ db }, i) => fin.deleteTransactions(db, i.ids) },

  'rules.list': { mutates: false, assistant: true, handler: ({ db }) => fin.listRules(db) },
  'rules.create': { mutates: true, assistant: true, handler: ({ db }, i) => fin.createRule(db, i) },
  'rules.delete': {
    mutates: true,
    assistant: false,
    handler: ({ db }, { id }) => {
      fin.deleteRule(db, id)
      return fin.listRules(db)
    }
  },

  'budgets.list': { mutates: false, assistant: true, handler: ({ db }, { month }) => fin.listBudgets(db, month) },
  'budgets.set': { mutates: true, assistant: true, handler: ({ db }, i) => fin.setBudget(db, i) },
  'budgets.copyPrevious': { mutates: true, assistant: false, handler: ({ db }, { month }) => fin.copyBudgets(db, month) },

  'summary.month': { mutates: false, assistant: true, handler: ({ db }, { month }) => fin.monthSummary(db, month) },

  'import.analyze': {
    mutates: false,
    assistant: false,
    handler: ({ db }, i) => imp.analyze(db, { fileName: i.fileName, accountId: i.accountId, bytes: new Uint8Array(Buffer.from(i.contentBase64, 'base64')) })
  },
  'import.preview': { mutates: false, assistant: false, handler: ({ db }, { sessionId }) => imp.preview(db, sessionId) },
  'import.current': {
    mutates: false,
    assistant: true,
    handler: ({ db }) => {
      const id = imp.latestSession()
      return id ? imp.preview(db, id) : null
    }
  },
  'import.raw': { mutates: false, assistant: true, handler: (_c, { from, count }) => imp.rawWindow(openSession(), from, count) },
  'import.remap': { mutates: false, assistant: true, handler: ({ db, actor }, i) => imp.remap(db, i.sessionId ?? openSession(), i.mapping, actor === 'assistant' ? 'assistant' : 'manual') },
  'import.updateRows': {
    mutates: false,
    assistant: true,
    handler: ({ db, actor }, i) =>
      imp.updateRows(
        db,
        i.sessionId ?? openSession(),
        i.changes.map((c) => ({ ...c, ...(c.categoryId !== undefined ? { categorySource: actor === 'assistant' ? ('assistant' as const) : ('user' as const) } : {}) }))
      )
  },
  'import.commit': { mutates: true, assistant: true, handler: ({ db }, i) => imp.commit(db, i.sessionId ?? openSession(), i.saveProfile) },
  'import.discard': {
    mutates: false,
    assistant: false,
    handler: (_c, { sessionId }) => {
      imp.discard(sessionId)
      return { ok: true as const }
    }
  },
  'import.batches': { mutates: false, assistant: false, handler: ({ db }) => imp.listBatches(db) },
  'import.undo': { mutates: true, assistant: false, handler: ({ db }, { batchId }) => imp.undoBatch(db, batchId) }
}

function openSession(): string {
  const id = imp.latestSession()
  if (!id) throw new AppError('import.none', 'No CSV import is open. Ask the person to choose a file on the Import page.')
  return id
}

function listCategories(db: Db): Category[] {
  return (db.prepare('SELECT * FROM categories ORDER BY kind, sort_order, name').all() as CategoryRow[]).map(toCategory)
}

/** Validates input against the contract, runs the operation and records changes. */
export async function runOp<K extends OpName>(
  table: OpTable,
  ctx: OpContext,
  name: K,
  rawInput: unknown
): Promise<OpResult<OpOutput<K>>> {
  const def = table[name] as OpDef<K> | undefined
  if (!def || !Object.hasOwn(contract, name)) {
    return { ok: false, error: { code: 'op.unknown', message: `Unknown operation: ${String(name)}` } }
  }
  const parsed = contract[name].input.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return { ok: false, error: { code: 'op.invalid_input', message: z.prettifyError(parsed.error) } }
  }
  try {
    const data = await def.handler(ctx, parsed.data as OpParsedInput<K>)
    if (def.mutates) {
      try {
        ctx.db.prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)').run(ctx.actor, name, redact(name, parsed.data))
      } catch (err) {
        // Locked (e.g. right after "erase"): nothing to log into.
        if (!(err instanceof AppError && err.code === 'auth.locked')) throw err
      }
    }
    return { ok: true, data }
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message } }
    console.error(`[op ${String(name)}]`, err)
    return { ok: false, error: { code: 'op.failed', message: 'Something went wrong. Details are in the log.' } }
  }
}

/** Never store secrets in the audit log. */
function redact(name: string, input: unknown): string {
  if (/^(auth|transfer|backup|prefs)\./.test(name)) return '{}'
  return JSON.stringify(input)
}
