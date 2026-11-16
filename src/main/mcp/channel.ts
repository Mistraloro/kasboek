/** Where the running app and the kasboek-mcp helper meet: a named pipe (Windows) or a Unix socket, found via a discovery file. */
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * A new random name on each start, published in the discovery file: another program can't claim
 * the name first and so stop the bridge from starting.
 */
export function socketPath(): string {
  const id = `${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 8)}-${randomBytes(8).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\kasboek-mcp-${id}` : join(tmpdir(), `kasboek-mcp-${id}.sock`)
}

export function discoveryFile(): string {
  return join(app.getPath('userData'), 'mcp-bridge.json')
}

/** The kasboek-mcp helper shipped next to the app (built from tools/kasboek-mcp). */
export function helperPath(): string {
  const exe = process.platform === 'win32' ? 'kasboek-mcp.exe' : 'kasboek-mcp'
  return app.isPackaged ? join(process.resourcesPath, exe) : join(app.getAppPath(), 'build', 'mcp', `${process.platform}-${process.arch}`, exe)
}

export interface BridgeRequest {
  token: string
  id: number
  call: 'list' | 'tool'
  name?: string
  input?: unknown
  /** The Claude app's name from MCP initialize, e.g. "claude-ai" or "claude-code" (newer helpers). */
  client?: string
}

export type BridgeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
