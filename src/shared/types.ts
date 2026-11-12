export type Theme = 'system' | 'light' | 'dark'
export type CategoryKind = 'expense' | 'income' | 'transfer'
export type Actor = 'user' | 'assistant' | 'system'

/** Banks we ship CSV profiles for. `other` covers anything else. */
export const BANKS = ['argenta', 'hellobank', 'keytrade', 'other'] as const
export type Bank = (typeof BANKS)[number]

export interface Account {
  id: number
  name: string
  bank: Bank
  iban: string | null
  currency: string
  openingBalanceCents: number
  archived: boolean
  createdAt: string
}

export interface Category {
  id: number
  name: string
  kind: CategoryKind
  parentId: number | null
  color: string | null
  sortOrder: number
  archived: boolean
}

/** Data settings, stored in the encrypted database. */
export interface Settings {
  currency: string
  autoBackupEnabled: boolean
  autoBackupFolder: string | null
  autoBackupKeep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
}

/** Interface preferences, stored outside the database so the lock screen can use them. */
export interface Prefs {
  theme: Theme
  /** UI language (i18n resource key). */
  language: string
  /** Locale used to format numbers and dates, e.g. `en-BE` or `nl-BE`. */
  formatLocale: string
  /** Lock after this many minutes without keyboard or mouse use. 0 = never. */
  autoLockMinutes: number
}

export type AuthMode = 'password' | 'device'
export type DeviceAuthKind = 'windows-hello' | 'touch-id' | null

export interface AuthStatus {
  state: 'setup' | 'locked' | 'unlocked'
  mode: AuthMode | null
  twoFactor: boolean
  device: DeviceAuthKind
  throttleSeconds: number
  /** Unlocked with the recovery key; a new password should be chosen. */
  recovered: boolean
  /** Data from an earlier version exists and will be kept at setup. */
  legacyData: boolean
  keyProtection: KeyProtection
  error: { code: string; message: string } | null
}

export type KeyProtection = 'os' | 'weak'

export interface AppInfo {
  name: string
  version: string
  platform: NodeJSPlatform
  dataDir: string
  /** Command and arguments to run Kasboek as an MCP server. */
  mcpCommand: { command: string; args: string[] }
}

/** Narrowed copy of `NodeJS.Platform`, so the renderer does not need Node types. */
export type NodeJSPlatform = 'win32' | 'darwin' | 'linux' | 'aix' | 'android' | 'freebsd' | 'haiku' | 'openbsd' | 'sunos' | 'cygwin' | 'netbsd'

export interface BackupStatus {
  autoEnabled: boolean
  folder: string | null
  keep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
}

export interface PickedTransfer {
  token: string
  fileName: string
  kind: 'export' | 'backup'
  createdAt: string
  appVersion: string
  mode: AuthMode
  twoFactor: boolean
  hasPassword: boolean
  /** Passwordless export, but this computer has no Windows Hello / Touch ID. */
  needsNewPassword: boolean
}

export interface Transaction {
  id: number
  accountId: number
  accountName: string
  bookingDate: string
  valueDate: string | null
  amountCents: number
  currency: string
  description: string
  counterpartyName: string | null
  counterpartyIban: string | null
  communication: string | null
  categoryId: number | null
  categoryName: string | null
  notes: string | null
  importBatchId: number | null
}

export interface TransactionPage {
  items: Transaction[]
  total: number
  inCents: number
  outCents: number
}

export type RuleField = 'counterparty' | 'description' | 'any'

export interface Rule {
  id: number
  field: RuleField
  pattern: string
  categoryId: number
  categoryName: string
}

export interface BudgetRow {
  categoryId: number
  name: string
  budgetCents: number | null
  spentCents: number
}

export interface MonthSummary {
  month: string
  incomeCents: number
  spendingCents: number
  budgetedCents: number
  /** Budget left for the month; null when no budgets are set. */
  leftCents: number | null
  byCategory: { categoryId: number | null; name: string; cents: number }[]
  uncategorized: number
  history: { month: string; incomeCents: number; spendingCents: number }[]
}

export interface AccountWithBalance extends Account {
  balanceCents: number
  transactionCount: number
}
