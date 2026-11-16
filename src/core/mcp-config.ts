/**
 * Adding Kasboek to (or removing it from) Claude Desktop's claude_desktop_config.json without
 * touching anything else in it. Pure functions: the caller reads, backs up and writes the file.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Claude Code: whether `claude mcp get kasboek` succeeded (`ok`) and whether what it prints names
 * this installation's helper and data folder. Paths are compared ignoring case and slash direction.
 */
export function codeEntryState(ok: boolean, out: string, entry: ServerEntry): 'absent' | 'current' | 'outdated' {
  if (!ok) return 'absent'
  const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase()
  const text = norm(out)
  return [entry.command, ...entry.args].every((part) => text.includes(norm(part))) ? 'current' : 'outdated'
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

const CONFIG = 'claude_desktop_config.json'

/** Subfolders of `dir` whose name matches, or none when `dir` can't be read. */
function subdirs(dir: string, name: RegExp): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && name.test(d.name))
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

/**
 * Claude Desktop's config files; the first is the one it reads. On Windows the location depends
 * on how Claude Desktop was installed: newer versions keep their data in
 * %LOCALAPPDATA%\Claude-Data\claude_<id>, an app-package (MSIX) install in its private copy of
 * AppData (%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude), older versions in
 * %APPDATA%\Claude. Every copy that exists is updated, so whichever one Claude reads has Kasboek.
 * Linux has no official Claude Desktop; offered only if the folder exists.
 */
export function claudeDesktopConfigPaths(platform: string, env: Record<string, string | undefined>, home: string): string[] {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const roaming = join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', CONFIG)
    const dataDirs = subdirs(join(local, 'Claude-Data'), /^claude/i).flatMap((d) => [d, join(d, 'Claude')])
    const packageDirs = subdirs(join(local, 'Packages'), /^(Anthropic\.)?Claude_/i).map((d) => join(d, 'LocalCache', 'Roaming', 'Claude'))
    const found = [...dataDirs, ...packageDirs].map((d) => join(d, CONFIG)).filter((f) => existsSync(f))
    // The most recently changed file first: that is the copy Claude Desktop uses.
    found.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)
    return [...new Set([...found, roaming])]
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude', CONFIG)]
  const dir = join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Claude')
  return existsSync(dir) ? [join(dir, CONFIG)] : []
}
