/** More models than this and the picker offers a search box. */
export const MODEL_SEARCH_THRESHOLD = 12

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

/** The options that match a search text (case-insensitive); the current value always stays. */
export function filterModels(options: readonly string[], query: string, current: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  return options.filter((m) => m === current || m.toLowerCase().includes(q))
}
