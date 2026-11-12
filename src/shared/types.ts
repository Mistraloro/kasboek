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

export interface Settings {
  theme: Theme
  /** UI language (i18n resource key). */
  language: string
  /** Locale used to format numbers and dates, e.g. `en-BE` or `nl-BE`. */
  formatLocale: string
  currency: string
  autoBackupEnabled: boolean
  autoBackupFolder: string | null
  autoBackupKeep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
}

export type KeyProtection = 'os' | 'weak'

export interface AppInfo {
  name: string
  version: string
  platform: NodeJSPlatform
  dataDir: string
  keyProtection: KeyProtection
}

/** Narrowed copy of `NodeJS.Platform`, so the renderer does not need Node types. */
export type NodeJSPlatform = 'win32' | 'darwin' | 'linux' | 'aix' | 'android' | 'freebsd' | 'haiku' | 'openbsd' | 'sunos' | 'cygwin' | 'netbsd'

export interface BackupStatus {
  passwordSet: boolean
  autoEnabled: boolean
  folder: string | null
  keep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
}

export interface PickedBackup {
  token: string
  fileName: string
  createdAt: string
  appVersion: string
}
