/**
 * Adding Kasboek to (or removing it from) Claude Desktop's claude_desktop_config.json without
 * touching anything else in it. Pure functions: the caller reads, backs up and writes the file.
 */
import { AppError } from './errors'

export interface ServerEntry {
  command: string
  args: string[]
}

function parse(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new AppError('mcp.config_invalid', 'Claude Desktop’s config file isn’t valid JSON, so Kasboek left it alone. Fix or remove it, then try again.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError('mcp.config_invalid', 'Claude Desktop’s config file has an unexpected shape, so Kasboek left it alone.')
  }
  return data as Record<string, unknown>
}

function servers(config: Record<string, unknown>): Record<string, unknown> {
  const s = config['mcpServers']
  if (s === undefined) return {}
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new AppError('mcp.config_invalid', '“mcpServers” in Claude Desktop’s config isn’t a list of servers, so Kasboek left it alone.')
  }
  return s as Record<string, unknown>
}

export function desktopEntryState(text: string | null, entry: ServerEntry): 'absent' | 'current' | 'outdated' {
  let current: unknown
  try {
    current = servers(parse(text))['kasboek']
  } catch {
    return 'absent'
  }
  if (!current) return 'absent'
  return JSON.stringify(current) === JSON.stringify(entry) ? 'current' : 'outdated'
}

/** Returns the new file text with mcpServers.kasboek set; everything else is kept as it was. */
export function withKasboek(text: string | null, entry: ServerEntry): string {
  const config = parse(text)
  const next = { ...config, mcpServers: { ...servers(config), kasboek: entry } }
  return JSON.stringify(next, null, 2) + '\n'
}

export function withoutKasboek(text: string | null): string {
  const config = parse(text)
  const s = { ...servers(config) }
  delete s['kasboek']
  return JSON.stringify({ ...config, mcpServers: s }, null, 2) + '\n'
}
