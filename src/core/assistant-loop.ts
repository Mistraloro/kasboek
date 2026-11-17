/**
 * The assistant's tool loop, independent of Electron and of the network so it can be tested.
 * Read-only tools run directly. Tools that change data wait for the person to approve.
 */
import type Anthropic from '@anthropic-ai/sdk'

type Message = Anthropic.Beta.Messages.BetaMessage
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam

export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolStart'; name: string }
  | { type: 'tool'; name: string; ok: boolean }

export interface LoopDeps {
  /** One model call. Streams text through `onText` and the model's thinking (when shown) through `onThinking`; resolves with the final message. */
  call(messages: MessageParam[], onText: (t: string) => void, signal: AbortSignal, onThinking?: (t: string) => void): Promise<Message>
  /** True for errors worth re-issuing the same turn for (an unparseable streamed tool input). */
  retryable(err: unknown): boolean
  runTool(name: string, input: unknown): Promise<{ ok: boolean; content: string }>
  mutates(name: string): boolean
  /** Checks the input first, so the person is never asked to approve a call that would fail anyway. */
  precheck(name: string, input: unknown): string | null
  confirm(name: string, input: unknown): Promise<boolean>
  onEvent(e: LoopEvent): void
}

export type TurnEnd = 'done' | 'refusal' | 'max_tokens' | 'aborted' | 'too_many_steps'

const MAX_STEPS = 16
/** How often a reply that hit the length limit is picked up again before giving up. */
const MAX_CONTINUES = 2
/** How often a reply that stopped without finishing or asking for a tool is picked up again. */
const MAX_RESUMES = 2
const RESUME = 'Your previous reply stopped before you did what you said you would do. Carry on: call the tools you need now.'
const CONTINUE =
  'Your previous reply was cut off because it got too long (any unfinished tool call was dropped). Continue from there in smaller steps: keep your reasoning brief, use rules for shops that repeat, and send at most 200 ids per tool call.'

/** Adds a note for the model to the end of the conversation, keeping user and assistant turns alternating. */
function nudge(messages: MessageParam[], text: string): void {
  const last = messages.at(-1)
  if (last?.role !== 'user') return void messages.push({ role: 'user', content: text })
  const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content]
  content.push({ type: 'text', text })
  last.content = content
}

export async function runTurn(messages: MessageParam[], deps: LoopDeps, signal: AbortSignal): Promise<TurnEnd> {
  let retries = 0
  let continues = 0
  let resumes = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return 'aborted'
    let message: Message
    let firstThought = true
    try {
      message = await deps.call(
        messages,
        (t) => deps.onEvent({ type: 'text', text: t }),
        signal,
        (t) => {
          // Each step's reasoning starts on its own paragraph.
          deps.onEvent({ type: 'thinking', text: firstThought && step > 0 ? `\n\n${t}` : t })
          firstThought = false
        }
      )
      retries = 0
    } catch (err) {
      if (signal.aborted) return 'aborted'
      if (deps.retryable(err) && retries++ < 2) continue
      throw err
    }
    // Keep the whole assistant turn, thinking blocks included, exactly as returned.
    messages.push({ role: 'assistant', content: message.content })

    if (message.stop_reason === 'refusal') return 'refusal'
    const uses = message.content.filter((b): b is ToolUse => b.type === 'tool_use')
    if (message.stop_reason === 'max_tokens') {
      // A tool call cut off at max_tokens may parse as a partial object: never run it. Keep the
      // text (and thinking) written so far, and ask the model to carry on in smaller pieces.
      messages.pop()
      const kept = message.content.filter((b) => b.type !== 'tool_use' && b.type !== 'server_tool_use')
      if (kept.some((b) => b.type === 'text' && b.text.trim())) messages.push({ role: 'assistant', content: kept })
      if (continues++ >= MAX_CONTINUES) return 'max_tokens'
      nudge(messages, CONTINUE)
      if (kept.some((b) => b.type === 'text' && b.text.trim())) deps.onEvent({ type: 'text', text: '\n\n' })
      continue
    }
    if (!uses.length) {
      // end_turn is the only real end. A reply that stopped for another reason (the server paused it,
      // or it announced a tool call that never came) is not finished: it is picked up again, never
      // left as a silent dead end.
      if (message.stop_reason === 'end_turn' || resumes++ >= MAX_RESUMES) return 'done'
      if (message.stop_reason !== 'pause_turn') nudge(messages, RESUME)
      continue
    }

    const results: ToolResult[] = []
    for (const use of uses) {
      if (signal.aborted) return 'aborted'
      const invalid = deps.precheck(use.name, use.input)
      if (invalid) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: invalid })
        deps.onEvent({ type: 'tool', name: use.name, ok: false })
        continue
      }
      if (deps.mutates(use.name) && !(await deps.confirm(use.name, use.input))) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'The person declined this change. Do not retry it unless they ask.' })
        deps.onEvent({ type: 'tool', name: use.name, ok: false })
        continue
      }
      deps.onEvent({ type: 'toolStart', name: use.name })
      const r = await deps.runTool(use.name, use.input)
      deps.onEvent({ type: 'tool', name: use.name, ok: r.ok })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: r.content, ...(r.ok ? {} : { is_error: true }) })
    }
    // All results of one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results })
  }
  return 'too_many_steps'
}
