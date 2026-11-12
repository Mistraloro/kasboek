/** Where the running app and the `--mcp` helper meet: a named pipe (Windows) or a Unix socket, plus a token file. */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

export function socketPath(): string {
  const id = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  return process.platform === 'win32' ? `\\\\.\\pipe\\kasboek-mcp-${id}` : join(tmpdir(), `kasboek-mcp-${id}.sock`)
}

export function tokenFile(): string {
  return join(app.getPath('userData'), 'mcp-token')
}

export interface BridgeRequest {
  token: string
  id: number
  call: 'list' | 'tool'
  name?: string
  input?: unknown
}

export type BridgeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
