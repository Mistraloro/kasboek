/**
 * The single list of operations the app supports.
 *
 * The UI calls these over IPC. The in-app Claude chat and the MCP server call the same
 * operations (only those marked as assistant tools), so every path is validated the same way.
 */
import { z } from 'zod'
import { ASSISTANT_MODELS } from './types'
import { mappingSchema } from './import-mapping'
import { MONTH } from './month'
import { checkPassword } from './password'
import type { Account, AccountWithBalance, AssistantStatus, AppInfo, AuthStatus, BackupEntryInfo, BackupStatus, BudgetRow, Category, ImportBatch, ImportPreview, MonthSummary, PickedTransfer, Prefs, Rule, Settings, Transaction, TransactionPage } from './types'

const out = <T>() => undefined as unknown as T
const empty = z.object({}).strict()
const password = z
  .string()
  .max(256)
  .refine((p) => checkPassword(p).ok, 'This password doesn’t meet the requirements: at least 16 characters, three kinds of characters, and not a common or predictable password.')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
const month = z.string().regex(MONTH, 'Use YYYY-MM.')
const id = z.number().int().positive()
const cents = z.number().int().min(-1e12).max(1e12)
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.')

export const contract = {
  /* ----- App & preferences (available while locked) ----- */
  'app.info': { input: empty, output: out<AppInfo>() },
  'app.ready': { input: empty, output: out<{ ok: true }>() },
  'prefs.get': { input: empty, output: out<Prefs>() },
  'prefs.update': {
    input: z
      .object({
        theme: z.enum(['system', 'light', 'dark']),
        language: z.string().min(2).max(10),
        formatLocale: z.string().min(2).max(20),
        autoLockMinutes: z.number().int().min(0).max(240)
      })
      .partial()
      .strict(),
    output: out<Prefs>()
  },

  /* ----- Login ----- */
  'auth.status': { input: empty, output: out<AuthStatus>() },
  'auth.setup': {
    input: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('password'), password }).strict(),
      z.object({ mode: z.literal('device') }).strict()
    ]),
    output: out<{ recoveryKey: string }>()
  },
  'auth.unlock': {
    input: z.object({ password: z.string().max(256).optional(), code: z.string().max(12).optional(), remember: z.boolean().optional() }).strict(),
    output: out<AuthStatus>()
  },
  'auth.forgetComputer': { input: empty, output: out<AuthStatus>() },
  'auth.unlockRecovery': { input: z.object({ recoveryKey: z.string().min(10).max(80) }).strict(), output: out<AuthStatus>() },
  'auth.lock': { input: empty, output: out<AuthStatus>() },
  'auth.erase': { input: z.object({ confirm: z.literal('ERASE') }).strict(), output: out<AuthStatus>() },
  'auth.changePassword': {
    input: z.object({ current: z.string().max(256).optional(), next: password }).strict(),
    output: out<AuthStatus>()
  },
  'auth.usePasswordless': { input: z.object({ current: z.string().max(256).optional() }).strict(), output: out<AuthStatus>() },
  'auth.newRecoveryKey': { input: z.object({ current: z.string().max(256).optional() }).strict(), output: out<{ recoveryKey: string }>() },
  'auth.totpBegin': { input: empty, output: out<{ secret: string; uri: string; qrSvg: string }>() },
  'auth.totpEnable': { input: z.object({ code }).strict(), output: out<AuthStatus>() },
  'auth.totpDisable': { input: z.object({ code: z.string().max(12) }).strict(), output: out<AuthStatus>() },

  /* ----- Move computers, backups ----- */
  'transfer.export': { input: empty, output: out<{ file: string | null }>() },
  'transfer.pick': { input: empty, output: out<PickedTransfer | null>() },
  'transfer.import': {
    input: z
      .object({
        token: z.string().min(1),
        password: z.string().max(256).optional(),
        code: z.string().max(12).optional(),
        recoveryKey: z.string().max(80).optional(),
        newPassword: password.optional()
      })
      .strict(),
    output: out<AuthStatus>()
  },
  'backup.status': { input: empty, output: out<BackupStatus>() },
  'backup.chooseFolder': { input: empty, output: out<{ folder: string | null }>() },
  'backup.configureAuto': {
    input: z.object({ enabled: z.boolean(), keep: z.number().int().min(1).max(100).optional() }).strict(),
    output: out<BackupStatus>()
  },
  'backup.runNow': { input: empty, output: out<{ file: string }>() },
  'backup.list': { input: empty, output: out<BackupEntryInfo[]>() },
  'backup.pick': { input: z.object({ name: z.string().min(1).max(200) }).strict(), output: out<PickedTransfer>() },
  'backup.revealFolder': { input: empty, output: out<{ ok: boolean }>() },

  /* ----- Claude ----- */
  'assistant.status': { input: empty, output: out<AssistantStatus>() },
  'assistant.setKey': { input: z.object({ apiKey: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, 'That doesn’t look like an Anthropic API key (it starts with sk-ant-).') }).strict(), output: out<AssistantStatus>() },
  'assistant.clearKey': { input: empty, output: out<AssistantStatus>() },
  'assistant.configure': {
    input: z
      .object({
        chatModel: z.enum(ASSISTANT_MODELS),
        chatEffort: z.enum(['low', 'medium', 'high']),
        csvModel: z.enum(ASSISTANT_MODELS),
        csvEffort: z.enum(['low', 'medium', 'high']),
        mcpEnabled: z.boolean()
      })
      .partial()
      .strict(),
    output: out<Settings>()
  },
  'assistant.send': { input: z.object({ text: z.string().trim().min(1).max(8000) }).strict(), output: out<AssistantStatus>() },
  'assistant.confirm': { input: z.object({ id: z.string().uuid(), approve: z.boolean() }).strict(), output: out<AssistantStatus>() },
  'assistant.stop': { input: empty, output: out<AssistantStatus>() },
  'assistant.reset': { input: empty, output: out<AssistantStatus>() },
  'import.assist': { input: z.object({ sessionId: z.string().uuid() }).strict(), output: out<ImportPreview>() },
  'mcp.respond': { input: z.object({ id: z.string().uuid(), approve: z.boolean() }).strict(), output: out<{ ok: true }>() },

  /* ----- Data ----- */
  'settings.get': { input: empty, output: out<Settings>() },
  'settings.update': { input: z.object({ currency: z.string().length(3) }).partial().strict(), output: out<Settings>() },

  'accounts.list': {
    description: 'List bank accounts with their current balance (cents).',
    input: empty,
    output: out<AccountWithBalance[]>()
  },
  'accounts.update': {
    input: z.object({ id, name: z.string().trim().min(1).max(80).optional(), bank: z.string().trim().max(60).optional(), iban: z.string().trim().max(34).nullable().optional(), archived: z.boolean().optional() }).strict(),
    output: out<Account>()
  },
  'accounts.create': {
    input: z
      .object({
        name: z.string().trim().min(1).max(80),
        bank: z.string().trim().max(60).default(''),
        iban: z.string().trim().max(34).nullable().optional(),
        currency: z.string().length(3).default('EUR'),
        openingBalanceCents: z.number().int().default(0)
      })
      .strict(),
    output: out<Account>()
  },

  'categories.list': { description: 'List all categories (id, name, kind: expense/income/transfer).', input: empty, output: out<Category[]>() },
  'categories.create': {
    description: 'Create a new category.',
    input: z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['expense', 'income', 'transfer']) }).strict(),
    output: out<Category[]>()
  },
  'categories.update': {
    input: z.object({ id, name: z.string().trim().min(1).max(60).optional(), archived: z.boolean().optional() }).strict(),
    output: out<Category[]>()
  },

  'transactions.list': {
    description:
      'Search transactions. Amounts are integer cents: negative = money out, positive = money in. Filter by account, category (or "none" for uncategorised), month (YYYY-MM), date range, free-text search or direction. Returns a page plus totals for the whole filter.',
    input: z
      .object({
        accountId: id.optional(),
        categoryId: z.union([id, z.literal('none')]).optional(),
        month: month.optional(),
        from: date.optional(),
        to: date.optional(),
        search: z.string().max(100).optional(),
        direction: z.enum(['in', 'out']).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0)
      })
      .strict(),
    output: out<TransactionPage>()
  },
  'transactions.create': {
    input: z
      .object({
        accountId: id,
        bookingDate: date,
        amountCents: cents.refine((v) => v !== 0, 'Amount can’t be zero.'),
        description: z.string().trim().min(1).max(300),
        counterpartyName: z.string().trim().max(120).nullable().optional(),
        categoryId: id.nullable().optional(),
        notes: z.string().max(1000).nullable().optional()
      })
      .strict(),
    output: out<Transaction>()
  },
  'transactions.update': {
    input: z
      .object({
        id,
        categoryId: id.nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
        description: z.string().trim().min(1).max(300).optional(),
        bookingDate: date.optional(),
        amountCents: cents.optional(),
        counterpartyName: z.string().trim().max(120).nullable().optional()
      })
      .strict(),
    output: out<Transaction>()
  },
  'transactions.categorize': {
    description: 'Set the category of one or more transactions (categoryId null = uncategorised).',
    input: z.object({ ids: z.array(id).min(1).max(5000), categoryId: id.nullable() }).strict(),
    output: out<{ updated: number }>()
  },
  'transactions.delete': { input: z.object({ ids: z.array(id).min(1).max(5000) }).strict(), output: out<{ deleted: number }>() },

  'rules.list': { description: 'List categorisation rules ("text in counterparty/description → category").', input: empty, output: out<Rule[]>() },
  'rules.create': {
    description:
      'Create a rule that puts transactions whose counterparty and/or description contains `pattern` (case-insensitive) into a category. New imports use it; applyToExisting also categorises uncategorised transactions now.',
    input: z
      .object({
        field: z.enum(['counterparty', 'description', 'any']),
        pattern: z.string().trim().min(2).max(100),
        categoryId: id,
        applyToExisting: z.boolean().default(true)
      })
      .strict(),
    output: out<{ rule: Rule; applied: number }>()
  },
  'rules.delete': { input: z.object({ id }).strict(), output: out<Rule[]>() },

  'budgets.list': { description: 'Budgets and spending per spending category for a month (cents).', input: z.object({ month }).strict(), output: out<BudgetRow[]>() },
  'budgets.set': {
    description: 'Set (or clear with null) the monthly budget for a spending category, in cents.',
    input: z.object({ categoryId: id, month, amountCents: z.number().int().min(0).max(1e10).nullable() }).strict(),
    output: out<BudgetRow[]>()
  },
  'budgets.copyPrevious': { input: z.object({ month }).strict(), output: out<{ copied: number }>() },

  'import.analyze': {
    input: z.object({ fileName: z.string().min(1).max(260), contentBase64: z.string().min(1).max(14_000_000), accountId: id }).strict(),
    output: out<ImportPreview>()
  },
  'import.preview': { input: z.object({ sessionId: z.string().uuid() }).strict(), output: out<ImportPreview>() },
  'import.current': {
    description:
      'The CSV import the person has open: detected bank, column mapping, totals and every row with its status (ready / duplicate / problem / skipped), issues and category. Returns null when no import is open.',
    input: empty,
    output: out<ImportPreview | null>()
  },
  'import.raw': {
    description: 'Raw cells of the open CSV import (header row, any info lines above it, and a window of data rows by index). Use it to understand the file before changing the mapping.',
    input: z.object({ from: z.number().int().min(0).default(0), count: z.number().int().min(1).max(200).default(40) }).strict(),
    output: out<{ headerRow: number; header: string[]; rows: { index: number; cells: string[] }[]; totalRows: number; preamble: string[][] }>()
  },
  'import.remap': {
    description:
      'Change the column mapping of the open import: zero-based column indexes, headerRow (index of the header line in the file), dateOrder (DMY/YMD/MDY), decimal mark, invertSign. Nothing is saved until the import is committed.',
    input: z.object({ sessionId: z.string().uuid().optional(), mapping: mappingSchema }).strict(),
    output: out<ImportPreview>()
  },
  'import.updateRows': {
    description:
      'Fix rows of the open import before it is saved: set a category, correct a date (YYYY-MM-DD), amount (cents) or description, include a duplicate on purpose, or skip a row. Add a short note saying why. Nothing is saved until commit.',
    input: z
      .object({
        sessionId: z.string().uuid().optional(),
        changes: z
          .array(
            z
              .object({
                index: z.number().int().min(0),
                decided: z.enum(['include', 'skip']).nullable().optional(),
                categoryId: id.nullable().optional(),
                bookingDate: date.optional(),
                amountCents: cents.optional(),
                description: z.string().trim().min(1).max(300).optional(),
                note: z.string().max(200).nullable().optional()
              })
              .strict()
          )
          .min(1)
          .max(5000)
      })
      .strict(),
    output: out<ImportPreview>()
  },
  'import.commit': {
    description: 'Save the ready rows of the open import as transactions. Only after the person has reviewed the preview.',
    input: z.object({ sessionId: z.string().uuid().optional(), saveProfile: z.boolean().default(true) }).strict(),
    output: out<{ batchId: number; imported: number; skipped: number }>()
  },
  'import.discard': { input: z.object({ sessionId: z.string().uuid() }).strict(), output: out<{ ok: true }>() },
  'import.batches': { input: empty, output: out<ImportBatch[]>() },
  'import.undo': { input: z.object({ batchId: id }).strict(), output: out<{ deleted: number }>() },

  'summary.month': {
    description: 'Income, spending, budget left, spending per category and the last 6 months, for one month (cents).',
    input: z.object({ month }).strict(),
    output: out<MonthSummary>()
  }
} as const

export type Contract = typeof contract
export type ContractEntry = { input: z.ZodType; output: unknown; description?: string }
export type OpName = keyof Contract
export type OpInput<K extends OpName> = z.input<Contract[K]['input']>
export type OpParsedInput<K extends OpName> = z.output<Contract[K]['input']>
export type OpOutput<K extends OpName> = Contract[K]['output']

/** Operations that work while Kasboek is locked. Everything else needs a login. */
export const PUBLIC_OPS: readonly OpName[] = [
  'app.info',
  'app.ready',
  'prefs.get',
  'prefs.update',
  'auth.status',
  'auth.setup',
  'auth.unlock',
  'auth.unlockRecovery',
  'auth.erase',
  'transfer.pick',
  'transfer.import'
]

/** Result sent back over IPC. Errors are values, not thrown across the bridge. */
export type OpResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface KasboekBridge {
  invoke<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>>
  onEvent(listener: (event: AppEvent) => void): () => void
}

export type AppEvent =
  | { type: 'backup.completed'; file: string }
  | { type: 'backup.failed'; message: string }
  | { type: 'auth.locked'; reason: 'user' | 'idle' | 'system' }
  | { type: 'auth.refresh' }
  | { type: 'assistant.update'; status: AssistantStatus }
  | { type: 'import.updated' }
  | { type: 'data.changed'; actor: 'user' | 'assistant' | 'system' }
  | { type: 'mcp.request'; id: string; summary: string }
