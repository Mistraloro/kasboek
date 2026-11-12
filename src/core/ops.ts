import { z } from 'zod'
import { contract, type OpName, type OpOutput, type OpParsedInput, type OpResult } from '@shared/contract'
import type { Account, Actor, Bank, Category } from '@shared/types'
import type { Db } from './database'
import { AppError } from './errors'
import { getSettings, updateSettings } from './settings'

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
  bank: Bank
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
  'accounts.list': {
    mutates: false,
    assistant: true,
    handler: ({ db }) =>
      (db.prepare('SELECT * FROM accounts ORDER BY archived, name').all() as AccountRow[]).map(toAccount)
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
  'categories.list': {
    mutates: false,
    assistant: true,
    handler: ({ db }) =>
      (db.prepare('SELECT * FROM categories ORDER BY kind, sort_order, name').all() as CategoryRow[]).map(
        toCategory
      )
  }
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
      ctx.db
        .prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)')
        .run(ctx.actor, name, redact(name, parsed.data))
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
  if (name.startsWith('backup.')) return '{}'
  return JSON.stringify(input)
}
