/** Tools for Claude (in-app chat and MCP): the operations marked as assistant tools, with their schemas. */
import { z } from 'zod'
import type { Db } from '@core/database'
import { coreOps } from '@core/ops'
import { getSettings } from '@core/settings'
import { formatDate, formatMoney } from '@shared/format'
import { previewRule } from '@core/finance'
import { findRecurring } from '@core/recurring'
import { commitSummary, latestSession, preview, sessionKind } from '@core/import'
import type { RuleField, RuleMatch } from '@shared/types'
import { getPrefs } from '../prefs'
import { contract, type ContractEntry, type OpName } from '@shared/contract'
import type { ImportPreview } from '@shared/types'

export interface ToolDef {
  op: OpName
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates: boolean
}

export const toolName = (op: string): string => op.replace(/\./g, '_')

let cache: ToolDef[] | null = null

export function assistantTools(): ToolDef[] {
  if (cache) return cache
  cache = (Object.keys(contract) as OpName[])
    .filter((op) => coreOps[op]?.assistant)
    .map((op) => {
      const entry = contract[op] as ContractEntry
      const schema = z.toJSONSchema(entry.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
      delete schema['$schema']
      return { op, name: toolName(op), description: entry.description ?? op, inputSchema: schema, mutates: !!coreOps[op]?.mutates }
    })
  return cache
}

/** Null if the input is valid for the tool, otherwise a message for the model. */
export function precheck(name: string, input: unknown): string | null {
  const def = opForTool(name)
  if (!def) return `Unknown tool ${name}.`
  const r = (contract[def.op] as ContractEntry).input.safeParse(input ?? {})
  return r.success ? null : `Invalid input: ${z.prettifyError(r.error)}`
}

export function opForTool(name: string): ToolDef | undefined {
  return assistantTools().find((t) => t.name === name)
}

/** The in-app assistant's memory stays with the in-app assistant: Claude apps (MCP) don't get it. */
const CHAT_ONLY = new Set<OpName>(['memory.remember', 'memory.forget'])
export const isMemoryTool = (def: ToolDef): boolean => CHAT_ONLY.has(def.op)

export function mcpTools(): ToolDef[] {
  return assistantTools().filter((t) => !CHAT_ONLY.has(t.op))
}

/** Keeps tool results small enough for the model: import previews are summarised. */
export function compactResult(op: OpName, data: unknown, input?: unknown): string {
  if (op.startsWith('import.') && data && typeof data === 'object' && 'rows' in data) {
    const p = data as ImportPreview
    const flagged = p.rows.filter((r) => r.status !== 'ready')
    const ready = p.rows.filter((r) => r.status === 'ready')
    const slim = (r: ImportPreview['rows'][number]) => ({
      index: r.index,
      status: r.status,
      date: r.bookingDate,
      amountCents: r.amountCents,
      counterparty: r.counterpartyName,
      description: r.description.slice(0, 80),
      categoryId: r.categoryId,
      issues: r.issues.length ? r.issues : undefined
    })
    return JSON.stringify({
      fileName: p.fileName,
      account: p.accountName,
      layout: p.layout,
      fileKind: p.fileKind,
      ...(p.pdf ? { pdf: { tableFound: p.pdf.tableFound, readBy: p.pdf.readBy, reconciliation: p.pdf.reconciliation } } : {}),
      mappingSource: p.mappingSource,
      headers: p.headers.map((h, i) => `${i}: ${h}`),
      mapping: p.mapping,
      stats: p.stats,
      notes: p.notes,
      check: p.check ? { ...p.check, rules: p.check.rules.slice(0, 40), existing: p.check.existing.slice(0, 40) } : null,
      rowsNotReady: flagged.slice(0, 120).map(slim),
      readyRowsSample: ready.slice(0, 40).map(slim),
      omitted: Math.max(0, flagged.length - 120) + Math.max(0, ready.length - 40)
    })
  }
  if (op === 'transactions.list' && data && typeof data === 'object' && 'items' in data) {
    const page = data as { items: unknown[] }
    const offset = (input as { offset?: unknown } | undefined)?.offset
    return fitJson({ ...page, items: page.items.map(slimItem), offset: typeof offset === 'number' ? offset : 0 }, MAX_RESULT)
  }
  return fitJson(data, MAX_RESULT)
}

const MAX_RESULT = 60_000

/** Long bank texts are shortened in lists; the model can ask for one transaction when it needs more. */
function slimItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const o = { ...(item as Record<string, unknown>) }
  for (const k of ['importBatchId', 'valueDate', 'createdAt', 'updatedAt', 'fingerprint', 'uid']) delete o[k]
  if (typeof o['description'] === 'string' && o['description'].length > 140) o['description'] = `${o['description'].slice(0, 140)}…`
  for (const [k, v] of Object.entries(o)) if (v === null) delete o[k]
  return o
}

/**
 * Always valid JSON within `max` characters: lists keep as many whole items as fit and say where
 * to continue, instead of cutting the text in the middle of a value.
 */
export function fitJson(data: unknown, max: number): string {
  const text = JSON.stringify(data)
  if (text.length <= max) return text
  const listKey = Array.isArray(data) ? null : data && typeof data === 'object' ? Object.keys(data).find((k) => Array.isArray((data as Record<string, unknown>)[k])) : undefined
  if (listKey === undefined) return JSON.stringify({ truncated: true, note: 'The result was too large. Ask for less (a narrower filter or a smaller limit).' })
  const items = ((listKey === null ? data : (data as Record<string, unknown>)[listKey]) as unknown[]).map(slimItem)
  const rest = listKey === null ? {} : (data as Record<string, unknown>)
  const offset = typeof rest['offset'] === 'number' ? rest['offset'] : 0
  const build = (n: number): string =>
    JSON.stringify({
      ...rest,
      ...(listKey === null ? { items: items.slice(0, n) } : { [listKey]: items.slice(0, n) }),
      ...(n < items.length ? { truncated: true, shown: n, of: items.length, nextOffset: offset + n, note: 'Not all items fit. Ask again with this offset, or a narrower filter.' } : {})
    })
  // Binary search for the most whole items that fit.
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (build(mid).length <= max) lo = mid
    else hi = mid - 1
  }
  return build(lo)
}

/**
 * Whether this change saves an import that must wait for the person: one read from a PDF (always), or
 * from an XML statement that seems to be for another account or whose balances do not add up.
 */
export function isPdfCommit(op: OpName, input: unknown, db?: Db): boolean {
  if (op !== 'import.commit') return false
  const given = (input as { sessionId?: unknown } | null | undefined)?.sessionId
  const id = typeof given === 'string' ? given : latestSession()
  try {
    if (!id) return false
    const kind = sessionKind(id)
    if (kind === 'pdf') return true
    if (kind !== 'xml' || !db) return false
    const xml = preview(db, id).xml
    return !!xml && (xml.notes.some((n) => n.code === 'other_account') || (xml.reconciliation?.differenceCents ?? 0) !== 0)
  } catch {
    return false
  }
}

/** Money in the user's own formats, for confirmation cards. */
const money = (db: Db, c: number, currency = getSettings(db).currency): string => formatMoney(c, currency, getPrefs().formats)

/** One readable sentence for the confirmation card. */
export function describeChange(db: Db, op: OpName, input: Record<string, unknown>): string {
  const cat = (id: unknown): string => (id == null ? 'Uncategorised' : ((db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `category ${String(id)}`))
  switch (op) {
    case 'budgets.set':
      return input['amountCents'] === null
        ? `Remove the ${cat(input['categoryId'])} budget for ${String(input['month'])}`
        : `Set the ${cat(input['categoryId'])} budget for ${String(input['month'])} to ${money(db, Number(input['amountCents']))}`
    case 'transactions.categorize':
      return `Put ${describeTransactions(db, input['ids'])} in ${cat(input['categoryId'])}`
    case 'transactions.edit': {
      const tx = db.prepare('SELECT booking_date, amount_cents, currency, counterparty_name, description FROM transactions WHERE id = ?').get(input['id']) as
        | { booking_date: string; amount_cents: number; currency: string; counterparty_name: string | null; description: string }
        | undefined
      const what = tx ? `the transaction of ${tx.booking_date} (${money(db, tx.amount_cents, tx.currency)}, ${(tx.counterparty_name || tx.description).slice(0, 50)})` : 'a transaction'
      const parts: string[] = []
      if (input['categoryId'] !== undefined) parts.push(`category → ${cat(input['categoryId'])}`)
      if (input['counterpartyName'] !== undefined) parts.push(`name → “${String(input['counterpartyName'] ?? '')}”`)
      if (input['description'] !== undefined) parts.push(`description → “${String(input['description']).slice(0, 80)}”`)
      if (input['notes'] !== undefined) parts.push(input['notes'] ? `note → “${String(input['notes']).slice(0, 80)}”` : 'remove the note')
      return `Change ${what}: ${parts.join(', ') || 'nothing'}`
    }
    case 'transactions.rename':
      return `Rename ${describeTransactions(db, input['ids'])} to “${String(input['counterpartyName'])}”`
    case 'memory.remember':
      return `Remember: “${String(input['text']).slice(0, 300)}”`
    case 'memory.forget': {
      const ids = Array.isArray(input['ids']) ? (input['ids'] as unknown[]) : []
      const texts = ids.map((id) => (db.prepare('SELECT text FROM memories WHERE id = ?').get(id) as { text: string } | undefined)?.text).filter(Boolean)
      return texts.length ? `Forget: ${texts.map((t) => `“${String(t).slice(0, 120)}”`).join(', ')}` : 'Forget something that is no longer remembered'
    }
    case 'goals.create':
      return `Create the savings goal “${String(input['name'])}”: ${money(db, Number(input['targetCents']))}${input['targetDate'] ? ` by ${String(input['targetDate'])}` : ''}`
    case 'recurring.hide': {
      const found = findRecurring(db)
      const name = [...found.items, ...found.hidden].find((i) => i.key === input['key'])?.name ?? String(input['key']).replace(/^(in|out):/, '')
      return input['hidden'] === false ? `Count “${name}” as a fixed cost again` : `Stop counting “${name}” as a fixed cost`
    }
    case 'transactions.split': {
      const parts = (input['parts'] as { categoryId: number | null; amountCents: number }[] | undefined) ?? []
      if (!parts.length) return 'Remove the split of a transaction'
      return `Split a transaction into ${parts.map((p) => `${money(db, p.amountCents)} ${cat(p.categoryId)}`).join(', ')}`
    }
    case 'transfers.setCost': {
      const tx = db.prepare('SELECT currency FROM transactions WHERE transfer_pair = (SELECT transfer_pair FROM transactions WHERE id = ?) AND amount_cents < 0').get(input['id']) as { currency: string } | undefined
      return `Set the exchange cost of this transfer to ${money(db, Number(input['costCents']), tx?.currency)} (counted as a fee)`
    }
    case 'transfers.pair': {
      const n = (input['pairs'] as unknown[] | undefined)?.length ?? 0
      return `Pair ${n} transfer${n === 1 ? '' : 's'} between your own accounts (both halves count as neither income nor spending)`
    }
    case 'rules.create':
      return `Create a rule: ${ruleText(input)} → ${cat(input['categoryId'])}${input['applyToExisting'] === false ? '' : `, and apply it to uncategorised transactions${ruleReach(db, input)}`}`
    case 'rules.update': {
      const old = db.prepare('SELECT r.field, r.pattern, r.match, r.category_id FROM rules r WHERE r.id = ?').get(input['id']) as { field: string; pattern: string; match: string; category_id: number } | undefined
      if (!old) return 'Change a rule that no longer exists'
      const next = { field: input['field'] ?? old.field, pattern: input['pattern'] ?? old.pattern, match: input['match'] ?? old.match, categoryId: input['categoryId'] ?? old.category_id }
      return `Change the rule ${ruleText({ ...old, categoryId: old.category_id })} → ${cat(old.category_id)} into ${ruleText(next)} → ${cat(next.categoryId)}`
    }
    case 'rules.delete': {
      const old = db.prepare('SELECT field, pattern, match, category_id FROM rules WHERE id = ?').get(input['id']) as { field: string; pattern: string; match: string; category_id: number } | undefined
      return old ? `Delete the rule ${ruleText(old)} → ${cat(old.category_id)} (transactions keep their category)` : 'Delete a rule that no longer exists'
    }
    case 'categories.create':
      return `Create the ${String(input['kind'])} category “${String(input['name'])}”`
    case 'import.commit': {
      const id = typeof input['sessionId'] === 'string' ? input['sessionId'] : latestSession()
      if (!id) return 'Import the ready rows of the open CSV as transactions'
      try {
        const c = commitSummary(db, id)
        const fmt = getPrefs().formats
        const range = c.from && c.to ? (c.from === c.to ? `, ${formatDate(c.from, fmt)}` : `, ${formatDate(c.from, fmt)} – ${formatDate(c.to, fmt)}`) : ''
        const closing = c.closing ? `, and record the file’s closing balance ${money(db, c.closing.cents, c.currency)} on ${formatDate(c.closing.date, fmt)}` : ''
        const source = c.pdf ? `from the PDF statement${c.pdf.readBy === 'assistant' ? ' (read by the assistant from the statement’s text)' : ''} ` : ''
        const off = c.pdf?.differenceCents ? `. Warning: the rows don’t add up to the statement’s closing balance (difference ${money(db, c.pdf.differenceCents, c.currency)})` : ''
        return `Import ${c.rows} row${c.rows === 1 ? '' : 's'} ${source}(${money(db, c.totalCents, c.currency)}${range}) into ${c.accountName}${closing}${off}`
      } catch {
        return 'Import the ready rows of the open CSV as transactions'
      }
    }
    case 'accounts.create':
      return `Add the account “${String(input['name'])}”${input['currency'] && input['currency'] !== getSettings(db).currency ? ` in ${String(input['currency'])}` : ''}`
    case 'valuations.set': {
      const acc = db.prepare('SELECT name, currency FROM accounts WHERE id = ?').get(input['accountId']) as { name: string; currency: string } | undefined
      return `Record that ${acc?.name ?? 'the account'} was worth ${money(db, Number(input['valueCents']), acc?.currency)} on ${String(input['date'])}`
    }
    case 'balances.set': {
      const acc = db.prepare('SELECT name, currency FROM accounts WHERE id = ?').get(input['accountId']) as { name: string; currency: string } | undefined
      return `Record that the bank showed ${money(db, Number(input['balanceCents']), acc?.currency)} for ${acc?.name ?? 'the account'} at the end of ${String(input['date'])}`
    }
    case 'fx.setRate':
      return `Set the exchange rate on ${String(input['date'])}: 1 EUR = ${String(input['perEur'])} ${String(input['currency'])}`
    default:
      return `${op}: ${JSON.stringify(input).slice(0, 200)}`
  }
}

const FIELD_TEXT: Record<string, string> = { counterparty: 'counterparty', description: 'description', any: 'counterparty or description', iban: 'account number' }
const MATCH_TEXT: Record<string, string> = { contains: 'contains', word: 'contains the word', starts: 'starts with' }

function ruleText(r: Record<string, unknown>): string {
  const how = r['field'] === 'iban' ? 'is' : (MATCH_TEXT[String(r['match'] ?? 'contains')] ?? 'contains')
  return `${FIELD_TEXT[String(r['field'])] ?? String(r['field'])} ${how} “${String(r['pattern'])}”`
}

/** ", 14 now" style reach of a rule that is about to be created. */
function ruleReach(db: Db, input: Record<string, unknown>): string {
  try {
    const p = previewRule(db, { field: input['field'] as RuleField, pattern: String(input['pattern'] ?? ''), match: input['match'] as RuleMatch | undefined, categoryId: Number(input['categoryId']) })
    return ` (${p.uncategorised} now${p.otherCategory ? `; ${p.otherCategory} already in another category stay there` : ''})`
  } catch {
    return ''
  }
}

/** "25 transactions (−€6,412.30, 3 Jan – 2 Nov 2026): Golden Empire Tours, Bolt ×2, …" */
function describeTransactions(db: Db, ids: unknown): string {
  const list = Array.isArray(ids) ? ids.filter((x): x is number => Number.isSafeInteger(x)) : []
  if (!list.length) return 'no transactions'
  const rows: { booking_date: string; amount_cents: number; currency: string; counterparty_name: string | null; description: string }[] = []
  const q = db.prepare('SELECT booking_date, amount_cents, currency, counterparty_name, description FROM transactions WHERE id = ?')
  for (const id of list.slice(0, 5000)) {
    const r = q.get(id) as (typeof rows)[number] | undefined
    if (r) rows.push(r)
  }
  if (!rows.length) return `${list.length} transaction(s)`
  const main = getSettings(db).currency
  const total = rows.every((r) => r.currency === main) ? `${money(db, rows.reduce((t, r) => t + r.amount_cents, 0))}, ` : ''
  const dates = rows.map((r) => r.booking_date).sort()
  const fmt = getPrefs().formats
  const range = dates[0] === dates.at(-1) ? formatDate(dates[0]!, fmt) : `${formatDate(dates[0]!, fmt)} – ${formatDate(dates.at(-1)!, fmt)}`
  const payees = new Map<string, number>()
  for (const r of rows) {
    const name = (r.counterparty_name || r.description).trim().slice(0, 40)
    payees.set(name, (payees.get(name) ?? 0) + 1)
  }
  const top = [...payees.entries()].sort((a, b) => b[1] - a[1])
  const names = top.slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  return `${rows.length} transaction${rows.length === 1 ? '' : 's'} (${total}${range}): ${names.join(', ')}${top.length > 3 ? ', …' : ''}`
}
