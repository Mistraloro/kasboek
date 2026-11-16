/**
 * Inside the running app: accepts tool calls from the `kasboek-mcp` helper (started by Claude Desktop
 * or Claude Code), only while Kasboek is unlocked and MCP is switched on. Changes wait for the
 * person to approve them in the app, just like in the built-in chat.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { getSettings } from '@core/settings'
import { needsApproval } from '@shared/permissions'
import type { OpName, OpResult } from '@shared/contract'
import type { McpClientsSeen } from '@shared/types'
import { compactResult, describeChange, mcpTools, precheck } from '../assistant/tools'
import { broadcast, db, isUnlocked } from '../session'
import { discoveryFile, socketPath, type BridgeRequest, type BridgeResponse } from './channel'

type Run = (op: OpName, input: unknown, actor: 'assistant') => Promise<OpResult<unknown>>

let server: Server | null = null
/** Why the bridge couldn't start, shown in Settings → Assistant. */
let lastError: string | null = null
let failedAt = 0

export function mcpBridgeError(): string | null {
  return lastError
}

/** When a Claude app last used Kasboek over MCP (ms), for the tray menu. */
let lastUsed = 0
export function mcpBridgeState(): { running: boolean; lastUsed: number } {
  return { running: !!server, lastUsed }
}

/**
 * When each Claude app last reached Kasboek (ms). The helper checks the connection every few
 * seconds while the app runs, so a recent time means "connected now". The app is known by the
 * name it gives when it connects; older helpers don't pass it on ("other").
 */
const lastSeen: McpClientsSeen = { desktop: null, code: null, other: null }
export function clientKind(name: unknown): keyof McpClientsSeen {
  const n = String(name ?? '').toLowerCase()
  if (n === 'claude-code' || n.startsWith('claude-code')) return 'code'
  if (n === 'claude-ai' || n.includes('claude desktop') || n === 'claude') return 'desktop'
  return 'other'
}
export function mcpClientsSeen(): McpClientsSeen {
  return { ...lastSeen }
}
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

/** How long a change waits for the person before it counts as declined. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000

function askPerson(op: string, summary: string): Promise<boolean> {
  const id = randomUUID()
  broadcast({ type: 'mcp.request', id, op, summary })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      broadcast({ type: 'mcp.expired', id })
      resolve(false)
    }, APPROVAL_TIMEOUT_MS)
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
  lastUsed = Date.now()
  lastSeen[clientKind(req.client)] = lastUsed
  if (!isUnlocked()) return { id: req.id, ok: false, error: 'Kasboek is locked. Unlock it on your computer, then try again.' }
  if (!enabled()) return { id: req.id, ok: false, error: 'MCP access is switched off in Kasboek (Settings → Claude).' }
  if (req.call === 'list') return { id: req.id, ok: true, result: mcpTools().map(({ name, description, inputSchema, mutates }) => ({ name, description, inputSchema, mutates })) }
  const def = mcpTools().find((t) => t.name === String(req.name))
  if (!def) return { id: req.id, ok: false, error: `Unknown tool ${String(req.name)}.` }
  const invalid = precheck(def.name, req.input)
  if (invalid) return { id: req.id, ok: false, error: invalid }
  // Changes wait for the person unless their permissions let Claude apps make them too.
  if (def.mutates && needsApproval(getSettings(db()).permissions, def.op, req.input, 'mcp')) {
    const approved = await askPerson(def.op, describeChange(db(), def.op, (req.input ?? {}) as Record<string, unknown>))
    if (!approved) return { id: req.id, ok: false, error: 'The person declined this change in Kasboek. Do not retry it unless they ask.' }
  }
  const r = await run(def.op, req.input ?? {}, 'assistant')
  if (!r.ok) return { id: req.id, ok: false, error: r.error.message }
  if (def.op.startsWith('import.')) broadcast({ type: 'import.updated' })
  return { id: req.id, ok: true, result: compactResult(def.op, r.data, req.input) }
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
      const reply = (res: BridgeResponse): void => {
        if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(res) + '\n')
      }
      // Every request gets an answer, also when something fails (e.g. Kasboek locked meanwhile).
      handle(req, run).then(reply, (err: unknown) => {
        console.error('[mcp bridge]', err)
        reply({ id: req.id, ok: false, error: 'Kasboek couldn’t run this request. Check that it is open and unlocked, then try again.' })
      })
    }
  })
  socket.on('error', () => socket.destroy())
}

/** Starts or stops the bridge to match the setting. Safe to call often. */
export function syncMcpBridge(run: Run): void {
  const want = enabled()
  // After a failed start, try again every 30 seconds rather than every tick.
  if (want && !server && Date.now() - failedAt > 30_000) {
    token = randomBytes(32).toString('hex')
    const path = socketPath()
    // Tells the kasboek-mcp helper where to connect and with which token. Readable only by this user.
    writeFileSync(discoveryFile(), JSON.stringify({ socket: path, token }), { mode: 0o600 })
    if (process.platform !== 'win32' && existsSync(path)) rmSync(path, { force: true })
    server = createServer((s) => serve(s, run))
    lastError = null
    server.on('error', (err) => {
      console.error('[mcp bridge]', err)
      lastError = err.message
      failedAt = Date.now()
      server?.close()
      server = null
      rmSync(discoveryFile(), { force: true })
    })
    server.listen(path, () => {
      if (process.platform !== 'win32') import('node:fs').then((fs) => fs.chmodSync(path, 0o600)).catch(() => {})
    })
  } else if (!want && server) {
    server.close()
    server = null
    rmSync(discoveryFile(), { force: true })
    // Waiting approvals are declined; their cards say so instead of staying clickable.
    for (const [id, resolve] of pending) {
      broadcast({ type: 'mcp.expired', id })
      resolve(false)
    }
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
