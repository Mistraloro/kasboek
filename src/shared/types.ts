import type { ProviderId } from './ai-providers'
import type { FormatPrefs } from './format'
import type { LanguageCode } from './languages'
export type Theme = 'system' | 'light' | 'dark'
export type CategoryKind = 'expense' | 'income' | 'transfer'
export type Actor = 'user' | 'assistant' | 'system'


export const ACCOUNT_KINDS = ['current', 'savings', 'investment', 'cash', 'credit_card', 'loan', 'other'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export interface Account {
  id: number
  name: string
  kind: AccountKind
  /** The bank's name as the person typed it (may be empty). */
  bank: string
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

export interface FxRate {
  currency: string
  date: string
  /** Units of `currency` for 1 euro. */
  perEur: number
  source: 'ecb' | 'manual'
}

export interface FxCurrencyInfo {
  currency: string
  latest: { date: string; perEur: number; source: 'ecb' | 'manual' } | null
  ecbRates: number
  manualRates: number
  /** False when transactions are older than the first known rate (the first rate is used for them). */
  coversOldest: boolean
}

export interface FxStatus {
  main: string
  currencies: FxCurrencyInfo[]
  lastEcbUpdateAt: string | null
  autoUpdate: boolean
}

export interface Valuation {
  accountId: number
  date: string
  valueCents: number
  note: string | null
}

export interface NetWorthAccount {
  id: number
  name: string
  kind: AccountKind
  currency: string
  archived: boolean
  /** Today, in the account's currency. */
  valueCents: number
  valueMainCents: number | null
  /** Opening balance plus payments in and out; only for accounts with recorded values. */
  investedCents: number | null
  gainCents: number | null
  lastValuation: { date: string; valueCents: number } | null
}

export interface NetWorth {
  main: string
  totalCents: number
  assetsCents: number
  liabilitiesCents: number
  /** Accounts left out because their currency has no exchange rate. */
  unconverted: number
  accounts: NetWorthAccount[]
  /** Net worth at the end of each month (this month: today). */
  history: { month: string; cents: number; unconverted: number }[]
}

export interface YearSummary {
  year: number
  months: { month: string; incomeCents: number; spendingCents: number }[]
  categories: { categoryId: number | null; name: string; kind: 'income' | 'expense'; months: number[]; totalCents: number }[]
  incomeCents: number
  spendingCents: number
  budgetedCents: number
  /** Totals for every year with transactions. */
  years: { year: number; incomeCents: number; spendingCents: number }[]
}

export interface SyncDevice {
  id: string
  label: string
  lastSeen: string | null
  thisComputer: boolean
}

export interface SyncStatus {
  /** off: not syncing. on: syncing. detached: this data syncs, but this computer hasn't chosen the folder yet. */
  state: 'off' | 'on' | 'detached'
  folder: string | null
  devices: SyncDevice[]
  lastSyncAt: string | null
  /** A problem with the last sync, in plain words. */
  error: string | null
  conflicts: { id: number; at: string; summary: string }[]
  busy: boolean
}

/** Data settings, stored in the encrypted database. */
export interface Settings {
  /** Main currency: totals, budgets and net worth are shown in it. */
  currency: string
  /** Download the ECB reference rates by itself (at most once a day) when other currencies are in use. */
  fxAutoUpdate: boolean
  fxLastEcbUpdateAt: string | null
  autoBackupEnabled: boolean
  autoBackupFolder: string | null
  autoBackupKeep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
  chatModel: AssistantModel
  chatEffort: Effort
  csvModel: AssistantModel
  csvEffort: Effort
  /** Allow Claude Desktop / Claude Code to use Kasboek through MCP while it is unlocked. */
  mcpEnabled: boolean
  /** Which AI the in-app assistant uses. */
  aiProvider: ProviderId
  /** Base URL for providers where it can be changed (local servers, custom); null = the preset's. */
  aiBaseUrl: string | null
  /** Model names for OpenAI-compatible providers (Claude uses chatModel/csvModel). */
  aiChatModel: string
  aiCsvModel: string
}

export const ASSISTANT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const
export type AssistantModel = (typeof ASSISTANT_MODELS)[number]
export type Effort = 'low' | 'medium' | 'high'

export interface AssistantStatus {
  configured: boolean
  keyHint: string | null
  provider: ProviderId
  /** Shown as the assistant's name ("Claude", "Mistral", …). */
  providerName: string
  /** Who receives the data; null when the model runs on this computer or network. */
  company: string | null
  busy: boolean
  messages: ChatMessage[]
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string
      role: 'assistant'
      text: string
      tools: { name: string; ok: boolean }[]
      error?: string
      /** The model's reasoning, as far as the provider shares it. */
      thinking?: string
      /** A CSV check from the import screen, shown here while it runs and with its result. */
      check?: { fileName: string; groupsDone: number; groupsTotal: number; done: boolean; categorised?: number; renamed?: number; rules?: number; existing?: number }
    }
  | { id: string; role: 'confirm'; op: string; summary: string; state: 'pending' | 'approved' | 'declined' }

/** A change to the preferences; `formats` may hold only the parts that change. */
export type PrefsPatch = Partial<Omit<Prefs, 'formats'>> & { formats?: Partial<FormatPrefs> }

/** Interface preferences, stored outside the database so the lock screen can use them. */
export interface Prefs {
  theme: Theme
  /** UI language (i18n resource key). */
  language: LanguageCode
  /** Number, money and date formats; each part is chosen separately. */
  formats: FormatPrefs
  /** Lock after this many minutes without keyboard or mouse use. 0 = never. */
  autoLockMinutes: number
}

export type AuthMode = 'password' | 'device'
export type DeviceAuthKind = 'windows-hello' | 'touch-id' | null

export interface AuthStatus {
  state: 'setup' | 'locked' | 'unlocked'
  mode: AuthMode | null
  twoFactor: boolean
  /** 2FA is remembered on this computer until this time (ISO), or null. */
  rememberedUntil: string | null
  device: DeviceAuthKind
  /** Still finding out whether Windows Hello / Touch ID is available. */
  deviceChecking: boolean
  throttleSeconds: number
  /** Unlocked with the recovery key; a new password should be chosen. */
  recovered: boolean
  /** The current password doesn't meet today's rules; a stronger one must be chosen. */
  weakPassword: boolean
  /** Data from an earlier version exists and will be kept at setup. */
  legacyData: boolean
  keyProtection: KeyProtection
  error: { code: string; message: string } | null
}

export type KeyProtection = 'os' | 'weak'

export interface AppInfo {
  name: string
  version: string
  /** The commit the build was made from (empty in a development run without git). */
  commit: string
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
  /** The other account, when this is one half of a transfer between own accounts. */
  transferAccount: string | null
  /** Parts, when the transaction is split over several categories (0 = not split). */
  splitCount: number
}

/** One part of a split transaction. */
export interface SplitLine {
  categoryId: number | null
  categoryName: string | null
  amountCents: number
  note?: string | null
}

/** Two transactions that look like one transfer between the person's own accounts. */
export interface TransferPair {
  outId: number
  inId: number
  date: string
  amountCents: number
  currency: string
  fromAccount: string
  toAccount: string
  /** iban: the account number on one side is the other account's (sure); amount: same amount a few days apart. */
  confidence: 'iban' | 'amount'
  days: number
}

export interface TransactionPage {
  items: Transaction[]
  total: number
  inCents: number
  outCents: number
}

/** iban: the counterparty's account number (exact), e.g. to tell transfers to your own accounts apart. */
export type RuleField = 'counterparty' | 'description' | 'any' | 'iban'
/** contains: anywhere in the text; word: as a whole word; starts: at the start of the text. */
export type RuleMatch = 'contains' | 'word' | 'starts'

export interface Rule {
  id: number
  field: RuleField
  match: RuleMatch
  pattern: string
  categoryId: number
  categoryName: string
  priority: number
}

/** What a rule would do, shown before it is created. */
export interface RulePreview {
  /** Transactions it matches. */
  matches: number
  /** Of those, how many have no category yet (these it would categorise). */
  uncategorised: number
  /** Of those, how many already sit in another category (left as they are). */
  otherCategory: number
  /** The rule was made a whole-word rule because the text is short. */
  wholeWord: boolean
  examples: string[]
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
  /** Transactions this month in a currency without any exchange rate (left out of the totals). */
  unconverted: number
  history: { month: string; incomeCents: number; spendingCents: number }[]
}

export interface AccountWithBalance extends Account {
  /** The latest balance recorded from the bank (or read from a CSV). */
  lastBankBalance: { date: string; balanceCents: number; differenceCents: number | null } | null
  /** In the account's own currency. */
  balanceCents: number
  /** In the main currency at the latest rate; null when there is no rate. */
  balanceMainCents: number | null
  transactionCount: number
}

/** possible_duplicate: looks like a transaction already in Kasboek (same amount, a few days apart, similar text); not imported unless included. */
export type ImportRowStatus = 'ready' | 'duplicate' | 'possible_duplicate' | 'problem' | 'skipped'

export interface ImportRow {
  index: number
  line: number
  bookingDate: string | null
  amountCents: number | null
  description: string
  counterpartyName: string | null
  counterpartyIban: string | null
  communication: string | null
  categoryId: number | null
  /** Where the category came from. */
  categorySource: 'rule' | 'assistant' | 'user' | null
  issues: string[]
  status: ImportRowStatus
  /** The person chose to include or skip this row. */
  decided: 'include' | 'skip' | null
  note: string | null
  /** For a (possible) duplicate: the transaction already in Kasboek it matches. */
  match: { id: number; bookingDate: string; counterpartyName: string | null; description: string } | null
}

/** What an import did, and what it knows about the account's balance. */
export interface ImportCommitResult {
  batchId: number
  imported: number
  skipped: number
  /** Last date in the file: the day to compare the balance with the bank. */
  lastDate: string | null
  /** Kasboek's balance at the end of that day, after the import. */
  balanceOnLastDate: number | null
  /** A balance read from the CSV and recorded, compared with what Kasboek expected. */
  bankBalance: BankBalanceResult | null
  /** Why the file's closing balance wasn't recorded, if it wasn't. */
  balanceNote: string | null
  /** Transfers to or from another own account: paired at once (account number matches), and possible ones to check. */
  transfersPaired: number
  transfersSuggested: number
  /** The account has no recorded bank balance yet: ask for one. */
  askBalance: boolean
}

/** A balance the bank showed at the end of a day, compared with the one before it. */
export interface BankBalance {
  date: string
  balanceCents: number
  note: string | null
  /** What Kasboek expected from the previous recorded balance and the transactions since. */
  expectedCents: number | null
  /** Bank minus expected: not zero when a transaction is missing or counted twice. */
  differenceCents: number | null
  since: string | null
}

export interface BankBalanceResult {
  date: string
  balanceCents: number
  expectedCents: number | null
  differenceCents: number | null
}

/** What "Check" did to the open import, and what it proposes to change outside it. */
export interface CheckSummary {
  /** Who checked it (the assistant's name). */
  by: string
  /** Rows of this file already in Kasboek (not checked again). */
  alreadyImported: number
  total: number
  /** Changes made to the rows of this import; each part can be undone. */
  categorised: number
  renamed: number
  fixed: number
  mappingChanged: boolean
  /** Rules it suggests, checked against this file and what is already in Kasboek. */
  rules: ProposedRule[]
  /** Transactions already in Kasboek without a category that it would categorise. */
  existing: ProposedCategorisation[]
  /** Suggestions that were dropped, and why. */
  dropped: string[]
  /** What "Apply selected" already saved (not undone with the check; change it in Rules or Transactions). */
  applied: { rules: number; categorised: number } | null
}

export interface ProposedRule {
  id: number
  field: RuleField
  match: RuleMatch
  pattern: string
  categoryId: number
  categoryName: string
  /** Rows of this import it categorises. */
  rowsHere: number
  /** Uncategorised transactions already in Kasboek it would categorise. */
  existing: number
}

export interface ProposedCategorisation {
  id: number
  label: string
  categoryId: number
  categoryName: string
  count: number
  totalCents: number
}

export type CheckPart = 'categories' | 'names' | 'fixes' | 'all'

export interface ImportColumns {
  bookingDate: number
  valueDate?: number
  amount?: number
  debit?: number
  credit?: number
  currency?: number
  counterpartyName?: number
  counterpartyIban?: number
  description: number[]
  communication?: number
  bankReference?: number
  status?: number
  /** The account balance after each transaction, when the bank includes it. */
  balance?: number
}

export interface ImportMapping {
  delimiter: ';' | ',' | '\t' | '|'
  headerRow: number
  dateOrder: 'DMY' | 'YMD' | 'MDY'
  decimal: ',' | '.'
  invertSign: boolean
  columns: ImportColumns
}

export interface ImportPreview {
  sessionId: string
  fileName: string
  accountId: number
  accountName: string
  /** The account's currency; amounts in the preview are in it. */
  currency: string
  /** Internal id of a recognised file layout, or null. Not a bank list: any bank's CSV works. */
  layout: string | null
  encoding: string
  mappingSource: 'saved' | 'detected' | 'assistant' | 'manual' | 'none'
  headers: string[]
  sample: string[][]
  mapping: ImportMapping | null
  rows: ImportRow[]
  stats: {
    total: number
    ready: number
    duplicates: number
    possibleDuplicates: number
    problems: number
    skipped: number
    inCents: number
    outCents: number
    /** Period of the rows that will be imported. */
    from: string | null
    to: string | null
    /** Period of the whole file. */
    fileFrom: string | null
    fileTo: string | null
  }
  notes: string[]
  check: CheckSummary | null
}

export interface ImportBatch {
  id: number
  fileName: string
  accountName: string
  rowCount: number
  committedAt: string
  remaining: number
}

export interface BackupEntryInfo {
  name: string
  createdAt: string
  size: number
  tier: 'recent' | 'daily' | 'monthly'
}

export interface McpSetupStatus {
  entry: { command: string; args: string[] }
  helperFound: boolean
  /** null when Claude Desktop isn't available on this system. */
  desktop: { configPath: string; state: 'absent' | 'current' | 'outdated' } | null
  /** null when the `claude` command wasn't found. */
  code: { path: string; installed: boolean } | null
  devBuild: boolean
  /** Why the connection for Claude apps couldn't start, if it failed. */
  bridgeError: string | null
}
