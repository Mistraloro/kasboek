/** Where the running app and the kasboek-mcp helper meet: a named pipe (Windows) or a Unix socket, found via a discovery file. */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

export function socketPath(): string {
  const id = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
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
}

export type BridgeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
