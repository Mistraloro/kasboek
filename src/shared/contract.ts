/**
 * The single list of operations the app supports.
 *
 * The UI calls these over IPC. Later the in-app Claude chat and the MCP server
 * call the same operations, so every path goes through the same validation.
 * Input schemas are Zod, which can also be turned into JSON Schema for tool use.
 */
import { z } from 'zod'
import { BANKS } from './types'
import type { Account, AppInfo, BackupStatus, Category, PickedBackup, Settings } from './types'

const out = <T>() => undefined as unknown as T
const empty = z.object({}).strict()

export const settingsPatch = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    language: z.string().min(2).max(10),
    formatLocale: z.string().min(2).max(20),
    currency: z.string().length(3)
  })
  .partial()
  .strict()

export const contract = {
  'app.info': { input: empty, output: out<AppInfo>() },

  'settings.get': { input: empty, output: out<Settings>() },
  'settings.update': { input: settingsPatch, output: out<Settings>() },

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

  'categories.list': { input: empty, output: out<Category[]>() },

  'backup.status': { input: empty, output: out<BackupStatus>() },
  'backup.setPassword': {
    input: z.object({ password: z.string().min(10).max(256) }).strict(),
    output: out<BackupStatus>()
  },
  'backup.chooseFolder': { input: empty, output: out<{ folder: string | null }>() },
  'backup.configureAuto': {
    input: z
      .object({
        enabled: z.boolean(),
        keep: z.number().int().min(1).max(100).optional()
      })
      .strict(),
    output: out<BackupStatus>()
  },
  'backup.createNow': {
    input: z.object({ target: z.enum(['choose', 'auto']) }).strict(),
    output: out<{ file: string | null }>()
  },
  'backup.pick': { input: empty, output: out<PickedBackup | null>() },
  'backup.restore': {
    input: z.object({ token: z.string().min(1), password: z.string().min(1) }).strict(),
    output: out<{ restored: true }>()
  },
  'backup.revealFolder': { input: empty, output: out<{ ok: boolean }>() }
} as const

export type Contract = typeof contract
export type OpName = keyof Contract
export type OpInput<K extends OpName> = z.input<Contract[K]['input']>
export type OpParsedInput<K extends OpName> = z.output<Contract[K]['input']>
export type OpOutput<K extends OpName> = Contract[K]['output']

/** Shape of the result sent back over IPC. Errors are values, not thrown across the bridge. */
export type OpResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface KasboekBridge {
  invoke<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>>
  onEvent(listener: (event: AppEvent) => void): () => void
}

export type AppEvent = { type: 'backup.completed'; file: string } | { type: 'backup.failed'; message: string }
