/**
 * `Kasboek --mcp`: a Model Context Protocol server on stdin/stdout, for Claude Desktop, Claude Code
 * or any MCP client. It holds no keys and opens no database: it forwards each tool call to the
 * running, unlocked Kasboek app, which validates it and asks the person to approve changes.
 */
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { app } from 'electron'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { socketPath, tokenFile, type BridgeResponse } from './channel'

let socket: Socket | null = null
let nextId = 1
const waiting = new Map<number, (r: BridgeResponse) => void>()

function link(): Promise<Socket> {
  if (socket && !socket.destroyed) return Promise.resolve(socket)
  return new Promise((resolve, reject) => {
    const s = connect(socketPath())
    let buffer = ''
    s.setEncoding('utf8')
    s.on('connect', () => {
      socket = s
      resolve(s)
    })
    s.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const res = JSON.parse(buffer.slice(0, nl)) as BridgeResponse
        buffer = buffer.slice(nl + 1)
        waiting.get(res.id)?.(res)
        waiting.delete(res.id)
      }
    })
    s.on('error', () => reject(new Error('Kasboek isn’t running, is locked, or MCP access is off. Open Kasboek, unlock it, and turn on MCP in Settings → Claude.')))
    s.on('close', () => {
      socket = null
      for (const [id, done] of waiting) done({ id, ok: false, error: 'Kasboek closed the connection.' })
      waiting.clear()
    })
  })
}

async function ask(call: 'list' | 'tool', name?: string, input?: unknown): Promise<BridgeResponse> {
  let token: string
  try {
    token = readFileSync(tokenFile(), 'utf8').trim()
  } catch {
    return { id: 0, ok: false, error: 'Kasboek isn’t running, is locked, or MCP access is off. Open Kasboek, unlock it, and turn on MCP in Settings → Claude.' }
  }
  let s: Socket
  try {
    s = await link()
  } catch (err) {
    return { id: 0, ok: false, error: (err as Error).message }
  }
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    s.write(JSON.stringify({ token, id, call, name, input }) + '\n')
  })
}

export async function runMcpStdio(): Promise<void> {
  app.dock?.hide()
  const server = new Server({ name: 'kasboek', version: app.getVersion() }, { capabilities: { tools: {} }, instructions: 'Kasboek is the person’s private budget. Amounts are integer cents (negative = money out). Changes need the person’s approval inside the Kasboek app; if they decline, accept it.' })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await ask('list')
    if (!r.ok) return { tools: [] }
    const tools = r.result as { name: string; description: string; inputSchema: Record<string, unknown>; mutates: boolean }[]
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description + (t.mutates ? ' (Asks the person to approve in Kasboek.)' : ''),
        inputSchema: t.inputSchema as { type: 'object' },
        annotations: { readOnlyHint: !t.mutates }
      }))
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await ask('tool', req.params.name, req.params.arguments ?? {})
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error }] }
    return { content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result) }] }
  })

  await server.connect(new StdioServerTransport())
  // The MCP client closed us: stop.
  process.stdin.on('end', () => app.exit(0))
  process.stdin.on('close', () => app.exit(0))
}
