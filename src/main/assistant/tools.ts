/** Tools for Claude (in-app chat and MCP): the operations marked as assistant tools, with their schemas. */
import { z } from 'zod'
import type { Db } from '@core/database'
import { coreOps } from '@core/ops'
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

/** Keeps tool results small enough for the model: import previews are summarised. */
export function compactResult(op: OpName, data: unknown): string {
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
      bank: p.bank,
      mappingSource: p.mappingSource,
      headers: p.headers.map((h, i) => `${i}: ${h}`),
      mapping: p.mapping,
      stats: p.stats,
      notes: p.notes,
      rowsNotReady: flagged.slice(0, 120).map(slim),
      readyRowsSample: ready.slice(0, 40).map(slim),
      omitted: Math.max(0, flagged.length - 120) + Math.max(0, ready.length - 40)
    })
  }
  const text = JSON.stringify(data)
  return text.length > 60_000 ? text.slice(0, 60_000) + '… [truncated: ask for a narrower filter]' : text
}

const eur = (c: number): string => new Intl.NumberFormat('en-BE', { style: 'currency', currency: 'EUR' }).format(c / 100)

/** One readable sentence for the confirmation card. */
export function describeChange(db: Db, op: OpName, input: Record<string, unknown>): string {
  const cat = (id: unknown): string => (id == null ? 'Uncategorised' : ((db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `category ${String(id)}`))
  switch (op) {
    case 'budgets.set':
      return input['amountCents'] === null
        ? `Remove the ${cat(input['categoryId'])} budget for ${String(input['month'])}`
        : `Set the ${cat(input['categoryId'])} budget for ${String(input['month'])} to ${eur(Number(input['amountCents']))}`
    case 'transactions.categorize':
      return `Put ${(input['ids'] as unknown[] | undefined)?.length ?? 0} transaction(s) in ${cat(input['categoryId'])}`
    case 'rules.create':
      return `Create a rule: ${String(input['field'])} containing “${String(input['pattern'])}” → ${cat(input['categoryId'])}${input['applyToExisting'] === false ? '' : ', and apply it to uncategorised transactions'}`
    case 'categories.create':
      return `Create the ${String(input['kind'])} category “${String(input['name'])}”`
    case 'import.commit':
      return 'Import the ready rows of the open CSV as transactions'
    case 'accounts.create':
      return `Add the account “${String(input['name'])}”`
    default:
      return `${op}: ${JSON.stringify(input).slice(0, 200)}`
  }
}
