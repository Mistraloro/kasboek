/**
 * The plan a model returns when it checks a CSV import, how uncategorised rows are grouped for
 * it, and a forgiving reader for its answer. No Electron or network here, so it can be tested.
 */
import { z } from 'zod'
import type { ImportPreview } from '@shared/types'
import { AppError } from './errors'

const col = z.number().int().nullable()
const MappingPart = z.object({
  headerRow: z.number().int(),
  dateOrder: z.enum(['DMY', 'YMD', 'MDY']),
  decimal: z.enum([',', '.']),
  invertSign: z.boolean(),
  columns: z.object({
    bookingDate: z.number().int(),
    valueDate: col,
    amount: col,
    debit: col,
    credit: col,
    currency: col,
    counterpartyName: col,
    counterpartyIban: col,
    communication: col,
    bankReference: col,
    status: col,
    description: z.array(z.number().int())
  })
})
const FixPart = z.object({
  index: z.number().int(),
  action: z.enum(['fix', 'skip', 'include']),
  bookingDate: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  description: z.string().nullable(),
  reason: z.string()
})
/** One answer per group of similar transactions: its category and a readable name and description. */
const GroupPart = z.object({ group: z.number().int(), categoryId: z.number().int().nullable(), name: z.string().nullable(), description: z.string().nullable() })
/** What the model must return (also sent as the JSON schema). */
export const Plan = z.object({
  mapping: MappingPart.nullable(),
  fixes: z.array(FixPart),
  groups: z.array(GroupPart),
  notes: z.array(z.string())
})
export type Plan = z.infer<typeof Plan>

/** At most this many groups are sent (the most frequent first). */
export const MAX_GROUPS = 400

type Row = ImportPreview['rows'][number]

/**
 * Groups uncategorised rows that are clearly the same kind of payment: same counterparty (or
 * description when there is none) once numbers, dates and references are taken out, and the same
 * direction. "Bancontact DELHAIZE LEUVEN 03/10 12:34" and "… 17/10 18:02" become one group.
 */
export function groupKey(r: Pick<Row, 'counterpartyName' | 'description' | 'amountCents'>): string {
  const text = (r.counterpartyName?.trim() || r.description || '')
    .toLowerCase()
    .replace(/[0-9][0-9/.:,\-]*/g, ' ')
    .replace(/[^\p{L}\s&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return `${(r.amountCents ?? 0) < 0 ? 'out' : 'in'}:${text}`
}

/** Ready rows in groups of similar transactions, the biggest first. */
export function rowGroups(rows: Row[]): { key: string; sign: 'in' | 'out'; example: Row; rows: Row[] }[] {
  const map = new Map<string, { key: string; sign: 'in' | 'out'; example: Row; rows: Row[] }>()
  for (const r of rows) {
    if (r.status !== 'ready') continue
    const key = groupKey(r)
    let g = map.get(key)
    if (!g) map.set(key, (g = { key, sign: (r.amountCents ?? 0) < 0 ? 'out' : 'in', example: r, rows: [] }))
    g.rows.push(r)
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length)
}

/**
 * Reads the model's plan. Strict where it matters (each fix and category is checked), forgiving
 * where models slip: numbers written as text are accepted, and a single bad entry is dropped
 * instead of throwing away the whole answer.
 */
export function parsePlan(text: string, name: string): Plan {
  let raw: unknown
  try {
    raw = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    )
  } catch {
    throw new AppError('assistant.bad_plan', `${name}’s answer couldn’t be read. Try again, or try another model.`)
  }
  const strict = Plan.safeParse(raw)
  if (strict.success) return strict.data
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const keep = <T>(schema: z.ZodType<T>, items: unknown[]): T[] =>
    items.flatMap((item) => {
      const r = schema.safeParse(numbers(item))
      return r.success ? [r.data] : []
    })
  const mapping = o['mapping'] == null ? null : MappingPart.safeParse(numbers(o['mapping']))
  const plan: Plan = {
    mapping: mapping && mapping.success ? mapping.data : null,
    fixes: keep(FixPart, list(o['fixes'])),
    groups: keep(GroupPart, list(o['groups']).map((g) => (g && typeof g === 'object' ? { categoryId: null, name: null, description: null, ...g } : g))),
    notes: list(o['notes']).filter((n): n is string => typeof n === 'string')
  }
  if (!plan.fixes.length && !plan.groups.length && !plan.notes.length && !plan.mapping)
    throw new AppError('assistant.bad_plan', `${name}’s answer couldn’t be read. Try again, or try another model.`)
  return plan
}

/** Whole numbers written as text ("12") become numbers, where a number is expected. */
const NUMERIC = new Set(['index', 'group', 'categoryId', 'amountCents', 'headerRow'])
function numbers(v: unknown, key = '', inColumns = false): unknown {
  const num = (x: unknown): unknown => (typeof x === 'string' && /^-?\d+$/.test(x.trim()) ? Number(x.trim()) : x)
  // Inside mapping.columns every value is a column number (or a list of them).
  if (inColumns) return Array.isArray(v) ? v.map(num) : num(v)
  if (Array.isArray(v)) return v.map((x) => numbers(x))
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === 'columns' && x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).map(([c, y]) => [c, numbers(y, c, true)]))
          : numbers(x, k)
      ])
    )
  return NUMERIC.has(key) ? num(v) : v
}
