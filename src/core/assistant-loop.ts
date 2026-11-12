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
  | { type: 'tool'; name: string; ok: boolean }

export interface LoopDeps {
  /** One model call. Streams text through `onText`; resolves with the final message. */
  call(messages: MessageParam[], onText: (t: string) => void, signal: AbortSignal): Promise<Message>
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

export async function runTurn(messages: MessageParam[], deps: LoopDeps, signal: AbortSignal): Promise<TurnEnd> {
  let retries = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return 'aborted'
    let message: Message
    try {
      message = await deps.call(messages, (t) => deps.onEvent({ type: 'text', text: t }), signal)
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
    if (!uses.length) return message.stop_reason === 'max_tokens' ? 'max_tokens' : 'done'
    // A tool call cut off at max_tokens may parse as a partial object: never run it.
    if (message.stop_reason === 'max_tokens') {
      messages.pop()
      return 'max_tokens'
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
      const r = await deps.runTool(use.name, use.input)
      deps.onEvent({ type: 'tool', name: use.name, ok: r.ok })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: r.content, ...(r.ok ? {} : { is_error: true }) })
    }
    // All results of one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results })
  }
  return 'too_many_steps'
}
