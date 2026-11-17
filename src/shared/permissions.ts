/**
 * Which changes the assistant may make by itself and which wait for the person, like Claude's
 * permission modes. Every change belongs to one kind; a mode sets each kind to "ask" or "allow",
 * and the person can change single kinds. Some changes always ask (see needsApproval).
 */

/**
 * Kinds of change, with the operations they cover. "high" kinds are hard to undo, touch a lot, or
 * (memory) are sent along with every later chat.
 */
export const PERMISSION_KINDS = [
  { id: 'categorise', ops: ['transactions.categorize', 'transactions.edit', 'transactions.rename', 'transactions.split', 'transfers.pair', 'transfers.setCost'], risk: 'low' },
  { id: 'rules', ops: ['rules.create', 'rules.update'], risk: 'low' },
  { id: 'organise', ops: ['categories.create', 'budgets.set', 'goals.create', 'recurring.hide'], risk: 'low' },
  { id: 'balances', ops: ['balances.set', 'valuations.set', 'fx.setRate'], risk: 'high' },
  { id: 'deleteRules', ops: ['rules.delete'], risk: 'high' },
  { id: 'accounts', ops: ['accounts.create'], risk: 'high' },
  { id: 'import', ops: ['import.commit'], risk: 'high' },
  { id: 'memory', ops: ['memory.remember', 'memory.forget'], risk: 'high' }
] as const

export type PermissionKind = (typeof PERMISSION_KINDS)[number]['id']
export const PERMISSION_MODES = ['ask', 'smart', 'trust', 'custom'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type PermissionRule = 'ask' | 'allow'

/** At most this many transactions in one change go without asking, except in "trust". */
export const BULK_LIMIT = 100

export function kindOf(op: string): PermissionKind | null {
  return PERMISSION_KINDS.find((k) => (k.ops as readonly string[]).includes(op))?.id ?? null
}

/** What a mode allows: ask = nothing, smart = the low-risk kinds, trust = everything. */
export function presetRules(mode: Exclude<PermissionMode, 'custom'>): Record<PermissionKind, PermissionRule> {
  return Object.fromEntries(PERMISSION_KINDS.map((k) => [k.id, mode === 'trust' || (mode === 'smart' && k.risk === 'low') ? 'allow' : 'ask'])) as Record<PermissionKind, PermissionRule>
}

export interface PermissionSettings {
  mode: PermissionMode
  /** Only used in "custom". */
  rules: Partial<Record<PermissionKind, PermissionRule>>
  /** Changes asked for by Claude Desktop / Claude Code (MCP) always wait for the person. */
  mcpAlwaysAsk: boolean
}

export const DEFAULT_PERMISSIONS: PermissionSettings = { mode: 'ask', rules: {}, mcpAlwaysAsk: true }

/** How many transactions a change touches (for the bulk limit). */
function size(input: unknown): number {
  const ids = (input as { ids?: unknown } | null)?.ids
  if (Array.isArray(ids)) return ids.length
  const pairs = (input as { pairs?: unknown } | null)?.pairs
  return Array.isArray(pairs) ? pairs.length * 2 : 1
}

/**
 * True when the change must wait for the person: always for an unknown kind, for saving a PDF
 * import, for Claude apps (unless allowed), and for large changes outside "trust"; otherwise as the
 * mode or rule says.
 */
export function needsApproval(p: PermissionSettings, op: string, input: unknown, source: 'chat' | 'mcp', context: { pdfImport?: boolean } = {}): boolean {
  const kind = kindOf(op)
  if (!kind) return true
  // Text read from a PDF can be wrong in ways a CSV can't: saving it always waits for the person, even in "trust".
  if (op === 'import.commit' && context.pdfImport) return true
  if (source === 'mcp' && p.mcpAlwaysAsk) return true
  if (p.mode === 'ask') return true
  if (p.mode !== 'trust' && size(input) > BULK_LIMIT) return true
  const rules = p.mode === 'custom' ? { ...presetRules('ask'), ...p.rules } : presetRules(p.mode)
  return rules[kind] !== 'allow'
}
