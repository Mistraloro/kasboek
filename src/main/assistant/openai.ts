/**
 * The OpenAI-compatible Chat Completions format (Mistral, Groq, DeepSeek, Ollama, LM Studio,
 * OpenRouter, Together, Fireworks, Gemini and others). The tool loop keeps its history in
 * Anthropic's message shape; this file translates to and from the OpenAI shape per call.
 */
import { net } from 'electron'
import type Anthropic from '@anthropic-ai/sdk'
import { AppError } from '@core/errors'
import type { ActiveProvider } from './provider'

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type Message = Anthropic.Beta.Messages.BetaMessage

interface OaTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}
type OaMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string }

/** A streamed tool call whose arguments weren't valid JSON; the turn may be retried. */
export class ToolArgumentsError extends Error {}

/** An error from the provider, with its HTTP status. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const textOf = (content: MessageParam['content'] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('')

/** Anthropic-shaped history → OpenAI messages. */
export function toOpenAi(system: string, messages: MessageParam[], opts: { toolNames?: boolean } = {}): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }]
  const names = new Map<string, string>()
  for (const m of messages) {
    if (!m.content) continue
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OaMessage)
      continue
    }
    if (m.role === 'assistant') {
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []))
      for (const c of calls) names.set(c.id, c.function.name)
      // Empty text rather than null next to tool calls: some providers (Mistral) refuse null.
      out.push({ role: 'assistant', content: textOf(m.content) || (calls.length ? '' : null), ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    const text: string[] = []
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
        const name = names.get(b.tool_use_id)
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content, ...(opts.toolNames && name ? { name } : {}) })
      } else if (b.type === 'text') text.push(b.text)
    }
    if (text.length) out.push({ role: 'user', content: text.join('\n') })
  }
  return out
}

function headers(p: ActiveProvider): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (p.key) h['authorization'] = `Bearer ${p.key}`
  // OpenRouter asks apps to identify themselves; only the app's name is sent.
  if (p.preset.id === 'openrouter') h['x-title'] = 'Kasboek'
  return h
}

const url = (p: ActiveProvider, path: string): string => p.baseUrl.replace(/\/+$/, '') + path

async function failure(res: Response): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '')
  } catch {
    // Not JSON.
  }
  return new ProviderError(res.status, detail.slice(0, 300))
}

async function post(p: ActiveProvider, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response
  try {
    // No redirects: the API key must only ever go to the address the person entered.
    res = await net.fetch(url(p, path), { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal, redirect: 'error' })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ProviderError(0, err instanceof Error ? err.message : 'network error')
  }
  if (!res.ok) throw await failure(res)
  return res
}

/** Reads a server-sent-events stream of `data: {json}` lines. */
async function* events(res: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          // Skip a malformed keep-alive line.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

interface Chunk {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
  error?: { message?: string }
}

/**
 * The answer text from a message or stream chunk. Usually a string, but some providers (Mistral's
 * reasoning models, among others) send a list of parts: text parts, and "thinking" parts that
 * are the model's working, not the answer. Only the text is kept.
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      const p = part as { type?: string; text?: unknown }
      return (p.type === undefined || p.type === 'text' || p.type === 'output_text') && typeof p.text === 'string' ? p.text : ''
    })
    .join('')
}

/** The thinking parts of a message or chunk (Mistral: `{ type: 'thinking', thinking: [{ type: 'text', text }] }`). */
export function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = part as { type?: string; thinking?: unknown }
      if (p.type !== 'thinking') return ''
      if (typeof p.thinking === 'string') return p.thinking
      return Array.isArray(p.thinking) ? p.thinking.map((t) => (typeof t === 'string' ? t : typeof (t as { text?: unknown }).text === 'string' ? (t as { text: string }).text : '')).join('') : ''
    })
    .join('')
}

/** A call id when the provider sent none: 9 letters and digits, a form every provider accepts. */
const callId = (i: number): string => `k${Date.now().toString(36).slice(-6)}${i.toString(36).padStart(2, '0')}`.slice(0, 9)

/** JSON schema without the `$schema` marker, which some providers reject. */
function plainSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>
  return rest
}

/** One streamed chat call with tools; returns the result in Anthropic's message shape for the loop. */
export async function chat(
  p: ActiveProvider,
  opts: { system: string; messages: MessageParam[]; tools: { name: string; description: string; input_schema: unknown }[]; maxTokens: number },
  onText: (t: string) => void,
  signal: AbortSignal,
  onThinking?: (t: string) => void
): Promise<Message> {
  const tools: OaTool[] = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: plainSchema(t.input_schema) } }))
  const res = await post(p, '/chat/completions', { model: p.chatModel, messages: toOpenAi(opts.system, opts.messages, { toolNames: p.preset.id === 'mistral' }), tools, stream: true, max_tokens: opts.maxTokens }, signal)
  let text = ''
  let finish: string | null = null
  const calls: { id: string; name: string; args: string }[] = []
  for await (const raw of events(res, signal)) {
    const chunk = raw as Chunk
    if (chunk.error) throw new ProviderError(500, chunk.error.message ?? 'stream error')
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const d = choice.delta
    // Reasoning, where the provider shares it: thinking parts (Mistral) or a separate field
    // (reasoning_content: DeepSeek; reasoning: OpenRouter, Groq and others).
    const thought = contentThinking(d?.content) + (typeof d?.reasoning_content === 'string' ? d.reasoning_content : '') + (typeof d?.reasoning === 'string' ? d.reasoning : '')
    if (thought) onThinking?.(thought)
    const piece = contentText(d?.content)
    if (piece) {
      text += piece
      onText(piece)
    }
    for (const tc of d?.tool_calls ?? []) {
      const i = tc.index ?? calls.length
      const call = (calls[i] ??= { id: '', name: '', args: '' })
      if (tc.id) call.id = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (tc.function?.arguments) call.args += tc.function.arguments
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  const content: Message['content'] = []
  if (text) content.push({ type: 'text', text, citations: null } as Message['content'][number])
  for (const [i, c] of calls.entries()) {
    if (!c) continue
    let input: unknown
    try {
      input = c.args.trim() ? JSON.parse(c.args) : {}
    } catch {
      if (finish === 'length') break
      throw new ToolArgumentsError(`The model sent unreadable arguments for ${c.name}.`)
    }
    content.push({ type: 'tool_use', id: c.id || callId(i), name: c.name, input } as Message['content'][number])
  }
  const stop = finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : calls.length ? 'tool_use' : 'end_turn'
  return { content, stop_reason: stop } as unknown as Message
}

/**
 * One call that must answer with JSON matching `schema`. Uses a strict JSON schema where the
 * provider supports it, and falls back to plain JSON mode (with the schema in the prompt).
 */
export async function json(p: ActiveProvider, opts: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; signal?: AbortSignal }): Promise<string> {
  const base = { model: p.csvModel, max_tokens: opts.maxTokens }
  let res: Response
  try {
    res = await post(p, '/chat/completions', {
      ...base,
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: opts.schema } }
    }, opts.signal)
  } catch (err) {
    if (!(err instanceof ProviderError) || (err.status !== 400 && err.status !== 422) || opts.signal?.aborted) throw err
    res = await post(p, '/chat/completions', {
      ...base,
      messages: [
        { role: 'system', content: `${opts.system}\n\nAnswer with one JSON object only, matching this JSON schema:\n${JSON.stringify(opts.schema)}` },
        { role: 'user', content: opts.user }
      ],
      response_format: { type: 'json_object' }
    }, opts.signal)
  }
  const body = (await res.json()) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] }
  const choice = body.choices?.[0]
  if (choice?.finish_reason === 'length') throw new AppError('assistant.too_long', 'This file is too large for one check. Try a shorter export.')
  const text = contentText(choice?.message?.content)
  // Some models wrap JSON in a code fence.
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
}

export async function listModels(p: ActiveProvider): Promise<string[]> {
  let res: Response
  try {
    res = await net.fetch(url(p, '/models'), { headers: headers(p), redirect: 'error' })
  } catch (err) {
    throw new ProviderError(0, err instanceof Error ? err.message : 'network error')
  }
  if (!res.ok) throw await failure(res)
  const body = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] }
  const ids = (body.data ?? body.models ?? []).map((m) => (m as { id?: string }).id ?? (m as { name?: string }).name ?? '').filter(Boolean)
  return [...new Set(ids.map((id) => id.replace(/^models\//, '')))].sort()
}

/** Plain-language errors for the person. */
export function explainProviderError(err: unknown, name: string): string {
  if (err instanceof ProviderError) {
    const detail = err.message ? ` (${err.message})` : ''
    if (err.status === 0) return `Can’t reach ${name}${detail}. Check the address and your connection${name === 'Ollama' || name === 'LM Studio' ? `, and that ${name} is running` : ''}.`
    if (err.status === 401) return `The ${name} API key was not accepted. Check it in Settings → Assistant.`
    if (err.status === 403) return `${name} refused this request${detail}. The key may not have access to this model.`
    if (err.status === 404) return `${name} doesn’t know this model or address${detail}. Check them in Settings → Assistant.`
    if (err.status === 429) return `${name} is rate-limiting this key right now. Try again in a minute.`
    if (err.status === 400 || err.status === 422) return `${name} rejected the request${detail}. This model may not support tools; try another model.`
    return `${name} returned an error (${err.status})${detail}. Try again.`
  }
  if (err instanceof ToolArgumentsError) return `${name} sent a reply Kasboek couldn’t read. Try again, or try another model.`
  if (err instanceof AppError) return err.message
  return `Something went wrong talking to ${name}.`
}
