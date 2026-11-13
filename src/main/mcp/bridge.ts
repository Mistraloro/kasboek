/**
 * Inside the running app: accepts tool calls from the `kasboek-mcp` helper (started by Claude Desktop
 * or Claude Code), only while Kasboek is unlocked and MCP is switched on. Changes wait for the
 * person to approve them in the app, just like in the built-in chat.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { getSettings } from '@core/settings'
import type { OpName, OpResult } from '@shared/contract'
import { assistantTools, compactResult, describeChange, opForTool, precheck } from '../assistant/tools'
import { broadcast, db, isUnlocked } from '../session'
import { discoveryFile, socketPath, type BridgeRequest, type BridgeResponse } from './channel'

type Run = (op: OpName, input: unknown, actor: 'assistant') => Promise<OpResult<unknown>>

let server: Server | null = null
let token = ''
const pending = new Map<string, (ok: boolean) => void>()

export function respondMcp(id: string, approve: boolean): void {
  pending.get(id)?.(approve)
  pending.delete(id)
}

function enabled(): boolean {
  try {
    return isUnlocked() && getSettings(db()).mcpEnabled
  } catch {
    return false
  }
}

function askPerson(summary: string): Promise<boolean> {
  const id = randomUUID()
  broadcast({ type: 'mcp.request', id, summary })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(false)
    }, 120_000)
    pending.set(id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
  })
}

async function handle(req: BridgeRequest, run: Run): Promise<BridgeResponse> {
  const given = Buffer.from(String(req.token ?? ''))
  const expected = Buffer.from(token)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { id: req.id, ok: false, error: 'Not authorised.' }
  if (!isUnlocked()) return { id: req.id, ok: false, error: 'Kasboek is locked. Unlock it on your computer, then try again.' }
  if (!enabled()) return { id: req.id, ok: false, error: 'MCP access is switched off in Kasboek (Settings → Claude).' }
  if (req.call === 'list') return { id: req.id, ok: true, result: assistantTools().map(({ name, description, inputSchema, mutates }) => ({ name, description, inputSchema, mutates })) }
  const def = opForTool(String(req.name))
  if (!def) return { id: req.id, ok: false, error: `Unknown tool ${String(req.name)}.` }
  const invalid = precheck(def.name, req.input)
  if (invalid) return { id: req.id, ok: false, error: invalid }
  if (def.mutates) {
    const approved = await askPerson(describeChange(db(), def.op, (req.input ?? {}) as Record<string, unknown>))
    if (!approved) return { id: req.id, ok: false, error: 'The person declined this change in Kasboek. Do not retry it unless they ask.' }
  }
  const r = await run(def.op, req.input ?? {}, 'assistant')
  if (!r.ok) return { id: req.id, ok: false, error: r.error.message }
  if (def.op.startsWith('import.')) broadcast({ type: 'import.updated' })
  return { id: req.id, ok: true, result: compactResult(def.op, r.data) }
}

function serve(socket: Socket, run: Run): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 5_000_000) return socket.destroy()
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let req: BridgeRequest
      try {
        req = JSON.parse(line) as BridgeRequest
      } catch {
        socket.destroy()
        return
      }
      void handle(req, run).then((res) => socket.write(JSON.stringify(res) + '\n'))
    }
  })
  socket.on('error', () => socket.destroy())
}

/** Starts or stops the bridge to match the setting. Safe to call often. */
export function syncMcpBridge(run: Run): void {
  const want = enabled()
  if (want && !server) {
    token = randomBytes(32).toString('hex')
    const path = socketPath()
    // Tells the kasboek-mcp helper where to connect and with which token. Readable only by this user.
    writeFileSync(discoveryFile(), JSON.stringify({ socket: path, token }), { mode: 0o600 })
    if (process.platform !== 'win32' && existsSync(path)) rmSync(path, { force: true })
    server = createServer((s) => serve(s, run))
    server.on('error', (err) => console.error('[mcp bridge]', err))
    server.listen(path, () => {
      if (process.platform !== 'win32') import('node:fs').then((fs) => fs.chmodSync(path, 0o600)).catch(() => {})
    })
  } else if (!want && server) {
    server.close()
    server = null
    rmSync(discoveryFile(), { force: true })
    for (const resolve of pending.values()) resolve(false)
    pending.clear()
  }
}

export function stopMcpBridge(): void {
  server?.close()
  server = null
  try {
    rmSync(discoveryFile(), { force: true })
  } catch {
    // ignore
  }
}
