/**
 * The in-app conversation with Claude. Held in memory only and cleared when Kasboek locks.
 */
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { runTurn } from '@core/assistant-loop'
import { AppError } from '@core/errors'
import { getSettings } from '@core/settings'
import type { OpName, OpResult } from '@shared/contract'
import type { AssistantStatus, ChatMessage } from '@shared/types'
import { broadcast, db } from '../session'
import { client, explainError, modelParams } from './claude'
import * as openai from './openai'
import { activeProvider, isConfigured, requireConfigured } from './provider'
import { PROVIDERS } from '@shared/ai-providers'
import { assistantTools, compactResult, describeChange, opForTool, precheck } from './tools'

type Run = (op: OpName, input: unknown, actor: 'assistant') => Promise<OpResult<unknown>>
let run: Run | null = null
export function initAssistant(r: Run): void {
  run = r
}

let history: Anthropic.Beta.Messages.BetaMessageParam[] = []
let display: ChatMessage[] = []
let busy: AbortController | null = null
const pending = new Map<string, (ok: boolean) => void>()

const systemPrompt = (name: string): string => `You are ${name}, the assistant inside Kasboek, a private budgeting app on the person's own computer.

How the data works:
- Money is in integer cents. Negative = money out, positive = money in. Months are YYYY-MM, dates YYYY-MM-DD.
- Each account and transaction has its own currency. Totals, budgets and summaries are in the main currency (settings_get → currency), converted at the exchange rate of each transaction's date. Amounts in a currency without any rate are left out of totals (summary "unconverted"); fx_status shows the rates, fx_setRate adds one.
- Look things up with the tools; never guess or invent amounts, dates or names. If something isn't in the data, say so.
- Tools that change data (budgets, categories, rules, categorising, committing an import) pause for the person to approve in the app. Just call them; don't ask for permission in text first. If they decline, accept it.
- For CSV imports: use import_current and import_raw to understand the open file, fix the mapping with import_remap, fix or skip individual rows and set categories with import_updateRows (add a short note per change), and only commit with import_commit when the person asks you to import.

Style: short and plain. Lead with the answer. Write money with its currency, e.g. €1,234.56 or $80.00. Use the person's language. No tables unless asked.`

function status(): AssistantStatus {
  let configured = false
  let keyHint: string | null = null
  let preset = PROVIDERS.anthropic
  try {
    const p = activeProvider(db())
    preset = p.preset
    configured = isConfigured(p)
    keyHint = p.key ? `…${p.key.slice(-4)}` : null
  } catch {
    // Locked.
  }
  return { configured, keyHint, provider: preset.id, providerName: preset.assistantName, company: preset.company, busy: !!busy, messages: display }
}

let timer: NodeJS.Timeout | null = null
function publish(now = false): void {
  if (timer && !now) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(
    () => {
      timer = null
      broadcast({ type: 'assistant.update', status: status() })
    },
    now ? 0 : 60
  )
}

export function assistantStatus(): AssistantStatus {
  return status()
}

/** Tell the chat panel something changed (e.g. the API key was added). */
export function publishStatus(): void {
  publish(true)
}

export function resetChat(): void {
  busy?.abort()
  for (const resolve of pending.values()) resolve(false)
  pending.clear()
  history = []
  display = []
  publish(true)
}

export function stopChat(): void {
  busy?.abort()
  for (const resolve of pending.values()) resolve(false)
}

export function confirm(id: string, approve: boolean): void {
  const resolve = pending.get(id)
  if (!resolve) throw new AppError('assistant.no_confirm', 'This request is no longer waiting.')
  pending.delete(id)
  const card = display.find((m) => m.id === id)
  if (card && card.role === 'confirm') card.state = approve ? 'approved' : 'declined'
  resolve(approve)
  publish(true)
}

export function send(text: string): AssistantStatus {
  if (busy) throw new AppError('assistant.busy', 'The assistant is still answering.')
  if (!run) throw new Error('assistant not initialised')
  const database = db()
  const settings = getSettings(database)
  const provider = activeProvider(database)
  requireConfigured(provider)
  const native = provider.preset.id === 'anthropic'
  const anthropic = native ? client(database) : null
  const tools = assistantTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema, eager_input_streaming: true }))
  const today = new Date().toISOString().slice(0, 10)
  const system = `${systemPrompt(provider.preset.assistantName)}\n\nToday is ${today}.`

  display.push({ id: randomUUID(), role: 'user', text })
  let current: Extract<ChatMessage, { role: 'assistant' }> = { id: randomUUID(), role: 'assistant', text: '', tools: [] }
  display.push(current)
  const before = history.length
  history.push({ role: 'user', content: text })
  const controller = new AbortController()
  busy = controller
  publish(true)

  const runner = run
  void runTurn(
    history,
    {
      call: async (messages, onText, signal, onThinking) => {
        if (!anthropic) return openai.chat(provider, { system, messages, tools, maxTokens: 8192 }, onText, signal, onThinking)
        const stream = anthropic.beta.messages.stream(
          {
            ...modelParams(settings.chatModel, settings.chatEffort),
            max_tokens: 32000,
            system,
            // A readable summary of Claude's reasoning, shown in the panel (the default is empty).
            thinking: { type: 'adaptive', display: 'summarized' },
            cache_control: { type: 'ephemeral' },
            tools,
            messages
          },
          { signal }
        )
        stream.on('text', onText)
        if (onThinking) stream.on('thinking', (delta) => onThinking(delta))
        return stream.finalMessage()
      },
      retryable: (err) =>
        native ? !(err instanceof Anthropic.APIError) && !(err instanceof AppError) : err instanceof openai.ToolArgumentsError,
      mutates: (name) => opForTool(name)?.mutates ?? false,
      precheck,
      runTool: async (name, input) => {
        const def = opForTool(name)
        if (!def) return { ok: false, content: `Unknown tool ${name}.` }
        const r = await runner(def.op, input, 'assistant')
        if (!r.ok) return { ok: false, content: r.error.message }
        if (def.op.startsWith('import.')) broadcast({ type: 'import.updated' })
        return { ok: true, content: compactResult(def.op, r.data) }
      },
      confirm: (name, input) => {
        const def = opForTool(name)
        const id = randomUUID()
        const summary = def ? describeChange(db(), def.op, (input ?? {}) as Record<string, unknown>) : name
        display.push({ id, role: 'confirm', op: def?.op ?? name, summary, state: 'pending' })
        // Text after the card goes into a new bubble.
        current = { id: randomUUID(), role: 'assistant', text: '', tools: [] }
        display.push(current)
        publish(true)
        return new Promise<boolean>((resolve) => pending.set(id, resolve))
      },
      onEvent: (e) => {
        if (e.type === 'text') current.text += e.text
        else if (e.type === 'thinking') current.thinking = (current.thinking ?? '') + e.text
        else current.tools.push({ name: e.name, ok: e.ok })
        publish()
      }
    },
    controller.signal
  )
    .then((end) => {
      // A turn that ended mid-tool-loop would leave tool calls without results: roll back.
      if (end !== 'done' && history.at(-1)?.role === 'assistant' && JSON.stringify(history.at(-1)).includes('"tool_use"')) history.length = before
      const name = provider.preset.assistantName
      if (end === 'refusal') current.error = `${name} declined to answer this.`
      if (end === 'max_tokens') current.error = 'The answer was cut off. Ask for something shorter.'
      if (end === 'too_many_steps') current.error = `${name} took too many steps. Try a more specific question.`
      if (end === 'aborted') current.error = 'Stopped.'
    })
    .catch((err: unknown) => {
      current.error = native ? explainError(err) : openai.explainProviderError(err, provider.preset.assistantName)
      // Roll back to before this turn so the conversation stays valid (no tool call without its result).
      history.length = before
    })
    .finally(() => {
      display = display.filter((m) => !(m.role === 'assistant' && !m.text && !m.tools.length && !m.error && !m.thinking))
      busy = null
      publish(true)
    })
  return status()
}
