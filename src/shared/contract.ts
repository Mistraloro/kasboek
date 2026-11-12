/**
 * The single list of operations the app supports.
 *
 * The UI calls these over IPC. The in-app Claude chat and the MCP server call the same
 * operations (only those marked as assistant tools), so every path is validated the same way.
 */
import { z } from 'zod'
import { BANKS } from './types'
import type { Account, AppInfo, AuthStatus, BackupStatus, Category, PickedTransfer, Prefs, Settings } from './types'

const out = <T>() => undefined as unknown as T
const empty = z.object({}).strict()
const password = z.string().min(10, 'Use at least 10 characters.').max(256)
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.')

export const contract = {
  /* ----- App & preferences (available while locked) ----- */
  'app.info': { input: empty, output: out<AppInfo>() },
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
    input: z.object({ password: z.string().max(256).optional(), code: z.string().max(12).optional() }).strict(),
    output: out<AuthStatus>()
  },
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
  'backup.revealFolder': { input: empty, output: out<{ ok: boolean }>() },

  /* ----- Data ----- */
  'settings.get': { input: empty, output: out<Settings>() },
  'settings.update': { input: z.object({ currency: z.string().length(3) }).partial().strict(), output: out<Settings>() },

  'accounts.list': { input: empty, output: out<Account[]>() },
  'accounts.create': {
    input: z
      .object({
        name: z.string().trim().min(1).max(80),
        bank: z.enum(BANKS),
        iban: z.string().trim().max(34).nullable().optional(),
        currency: z.string().length(3).default('EUR'),
        openingBalanceCents: z.number().int().default(0)
      })
      .strict(),
    output: out<Account>()
  },

  'categories.list': { input: empty, output: out<Category[]>() }
} as const

export type Contract = typeof contract
export type OpName = keyof Contract
export type OpInput<K extends OpName> = z.input<Contract[K]['input']>
export type OpParsedInput<K extends OpName> = z.output<Contract[K]['input']>
export type OpOutput<K extends OpName> = Contract[K]['output']

/** Operations that work while Kasboek is locked. Everything else needs a login. */
export const PUBLIC_OPS: readonly OpName[] = [
  'app.info',
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
