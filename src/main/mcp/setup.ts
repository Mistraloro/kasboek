/**
 * One-click MCP setup: adds Kasboek to Claude Desktop's config file, or to Claude Code through its
 * own `claude mcp` command. Only on a button press; the file is backed up before it changes.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { AppError } from '@core/errors'
import { claudeDesktopConfigPaths, codeEntryState, desktopEntryState, withKasboek, withoutKasboek, type ServerEntry } from '@core/mcp-config'
import type { McpSetupStatus } from '@shared/types'
import { paths } from '../paths'
import { stamp } from '../transfer/service'
import { helperPath } from './channel'
import { mcpBridgeError } from './bridge'

export function serverEntry(): ServerEntry {
  return { command: helperPath(), args: ['--data-dir', paths.dataDir] }
}

/** Claude Desktop's config files; the first is the one it reads (see core/mcp-config). */
function desktopConfigPaths(): string[] {
  return claudeDesktopConfigPaths(process.platform, process.env, homedir())
}

async function readConfig(path: string): Promise<string | null> {
  return existsSync(path) ? readFile(path, 'utf8') : null
}

async function writeConfig(path: string, next: string): Promise<string | null> {
  await mkdir(dirname(path), { recursive: true })
  let backup: string | null = null
  if (existsSync(path)) {
    backup = `${path}.before-kasboek-${stamp()}`
    await copyFile(path, backup)
  }
  const tmp = `${path}.kasboek-tmp`
  await writeFile(tmp, next)
  await rename(tmp, path)
  return backup
}

export async function addToDesktop(): Promise<{ path: string; backup: string | null }> {
  const all = desktopConfigPaths()
  if (!all.length) throw new AppError('mcp.no_desktop', 'Claude Desktop isn’t available on this system.')
  // Check every file first, so a broken one stops the change before anything is written.
  const updates = await Promise.all(all.map(async (path) => ({ path, next: withKasboek(await readConfig(path), serverEntry()) })))
  let backup: string | null = null
  for (const [i, u] of updates.entries()) {
    const b = await writeConfig(u.path, u.next)
    if (i === 0) backup = b
  }
  return { path: all[0]!, backup }
}

export async function removeFromDesktop(): Promise<{ path: string; backup: string | null }> {
  const all = desktopConfigPaths().filter((p) => existsSync(p))
  if (!all.length) throw new AppError('mcp.no_desktop', 'Kasboek isn’t in Claude Desktop’s config.')
  let backup: string | null = null
  for (const [i, path] of all.entries()) {
    const b = await writeConfig(path, withoutKasboek(await readConfig(path)))
    if (i === 0) backup = b
  }
  return { path: all[0]!, backup }
}

/* ---------- Claude Code ---------- */

/** Finds the `claude` command. Apps started from the Dock/Start menu often have a short PATH, so common locations are tried too. */
function findClaudeCode(): string | null {
  const home = homedir()
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = [
    ...(process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':'),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.platform === 'win32' ? [join(process.env['APPDATA'] ?? '', 'npm'), join(home, '.local', 'bin')] : [])
  ].filter(Boolean)
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n)
  return null
}

function runClaude(exe: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // A .cmd shim needs cmd.exe; arguments are our own paths, quoted.
    const isCmd = exe.toLowerCase().endsWith('.cmd')
    const file = isCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : exe
    const argv = isCmd ? ['/d', '/s', '/c', [exe, ...args].map((a) => `"${a.replace(/"/g, '')}"`).join(' ')] : args
    execFile(file, argv, { timeout: 30_000, windowsHide: true, windowsVerbatimArguments: isCmd }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim().slice(0, 4000) })
    )
  })
}

/** `claude mcp get` prints the command it would start; another helper or data folder means out of date. */
async function codeState(exe: string): Promise<'absent' | 'current' | 'outdated'> {
  const r = await runClaude(exe, ['mcp', 'get', 'kasboek'])
  return codeEntryState(r.ok, r.out, serverEntry())
}

export async function addToCode(): Promise<void> {
  const exe = findClaudeCode()
  if (!exe) throw new AppError('mcp.no_code', 'Claude Code wasn’t found on this computer. Use the command shown below instead.')
  const entry = serverEntry()
  await runClaude(exe, ['mcp', 'remove', '--scope', 'user', 'kasboek'])
  const r = await runClaude(exe, ['mcp', 'add', '--scope', 'user', 'kasboek', '--', entry.command, ...entry.args])
  if (!r.ok) throw new AppError('mcp.code_failed', `Claude Code couldn’t add Kasboek: ${r.out || 'unknown error'}`)
}

export async function removeFromCode(): Promise<void> {
  const exe = findClaudeCode()
  if (!exe) throw new AppError('mcp.no_code', 'Claude Code wasn’t found on this computer.')
  const r = await runClaude(exe, ['mcp', 'remove', '--scope', 'user', 'kasboek'])
  if (!r.ok) throw new AppError('mcp.code_failed', `Claude Code couldn’t remove Kasboek: ${r.out || 'unknown error'}`)
}

export async function setupStatus(): Promise<McpSetupStatus> {
  const path = desktopConfigPaths()[0] ?? null
  const exe = findClaudeCode()
  return {
    entry: serverEntry(),
    helperFound: existsSync(helperPath()),
    desktop: path ? { configPath: path, state: desktopEntryState(await readConfig(path).catch(() => null), serverEntry()) } : null,
    code: exe ? { path: exe, state: await codeState(exe) } : null,
    devBuild: !app.isPackaged,
    bridgeError: mcpBridgeError()
  }
}
