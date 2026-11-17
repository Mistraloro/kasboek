/**
 * Every model a picker offers: the loaded ones, then the provider's suggested ones, without duplicates,
 * plus the current value when it is not in either list (a model the provider does not list).
 * Never depends on what is typed in a field.
 */
export function modelOptions(loaded: readonly string[], suggested: readonly string[], current: string): string[] {
  const all = [...new Set([...loaded, ...suggested].map((m) => m.trim()).filter(Boolean))]
  const value = current.trim()
  return value && !all.includes(value) ? [value, ...all] : all
}

/** The options that match a typed filter (case-insensitive); an empty filter matches everything. */
export function filterModels(options: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  return options.filter((m) => m.toLowerCase().includes(q))
}

/** One row of the open list: the "no model of its own" row, a model, or the typed name as a model the provider does not list. */
export type ModelRow = { kind: 'empty' } | { kind: 'model'; model: string } | { kind: 'custom'; model: string }

/**
 * The selectable rows for what is typed. Without a filter: every model (after the empty row, if there is one).
 * With a filter: the matching models, then `Use "<typed>"` unless the typed text is already a model of the list.
 */
export function modelRows(options: readonly string[], query: string, hasEmptyRow: boolean): ModelRow[] {
  const typed = query.trim()
  const rows: ModelRow[] = filterModels(options, typed).map((model) => ({ kind: 'model', model }))
  if (!typed) return hasEmptyRow ? [{ kind: 'empty' }, ...rows] : rows
  return options.includes(typed) ? rows : [...rows, { kind: 'custom', model: typed }]
}

/** The numbers of "Showing n of N models": null when nothing is being filtered. */
export function modelCounts(options: readonly string[], query: string): { shown: number; total: number } | null {
  if (!query.trim()) return null
  return { shown: filterModels(options, query).length, total: options.length }
}

/** What the field shows: the text being typed as a filter, otherwise the selected model. */
export function fieldText(value: string, query: string, filtering: boolean): string {
  return filtering ? query : value
}

/** Arrow keys: the next highlighted row, wrapping around the ends; -1 when there are no rows. */
export function moveHighlight(index: number, step: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (index < 0 || index >= count) return step === 1 ? 0 : count - 1
  return (index + step + count) % count
}

/** The row to highlight when the list opens: the current model, else the first row. */
export function initialHighlight(rows: readonly ModelRow[], value: string): number {
  const at = rows.findIndex((r) => (r.kind === 'model' ? r.model === value : r.kind === 'empty' && !value))
  return at >= 0 ? at : rows.length ? 0 : -1
}
