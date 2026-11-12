import { describe, expect, it } from 'vitest'
import { runTurn, type LoopDeps } from '@core/assistant-loop'

const msg = (content: unknown[], stop_reason: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason, usage: {} }) as never

function deps(script: unknown[], opts: { approve?: boolean } = {}) {
  const calls: string[] = []
  const events: unknown[] = []
  let i = 0
  const d: LoopDeps = {
    call: async (_m, onText) => {
      const next = script[i++] as ReturnType<typeof msg>
      for (const b of (next as unknown as { content: { type: string; text?: string }[] }).content) if (b.type === 'text') onText(b.text!)
      return next
    },
    retryable: () => false,
    runTool: async (name) => {
      calls.push(name)
      return { ok: true, content: '{"ok":true}' }
    },
    mutates: (name) => name === 'budgets_set',
    precheck: (_name, input) => ((input as { bad?: boolean })?.bad ? 'Invalid input' : null),
    confirm: async () => opts.approve ?? true,
    onEvent: (e) => events.push(e)
  }
  return { d, calls, events }
}

describe('assistant loop', () => {
  it('runs read tools, sends all results back in one message, then finishes', async () => {
    const { d, calls } = deps([
      msg([{ type: 'tool_use', id: 't1', name: 'summary_month', input: {} }, { type: 'tool_use', id: 't2', name: 'categories_list', input: {} }], 'tool_use'),
      msg([{ type: 'text', text: 'You spent €42.' }], 'end_turn')
    ])
    const messages: never[] = [{ role: 'user', content: 'how much?' } as never]
    expect(await runTurn(messages, d, new AbortController().signal)).toBe('done')
    expect(calls).toEqual(['summary_month', 'categories_list'])
    const toolMsg = messages[2] as unknown as { role: string; content: { type: string }[] }
    expect(toolMsg.role).toBe('user')
    expect(toolMsg.content).toHaveLength(2)
  })

  it('does not run a change the person declined', async () => {
    const { d, calls } = deps(
      [msg([{ type: 'tool_use', id: 't1', name: 'budgets_set', input: { categoryId: 1 } }], 'tool_use'), msg([{ type: 'text', text: 'OK, left it.' }], 'end_turn')],
      { approve: false }
    )
    const messages: never[] = [{ role: 'user', content: 'set it' } as never]
    await runTurn(messages, d, new AbortController().signal)
    expect(calls).toEqual([])
    expect(JSON.stringify(messages[2])).toContain('declined')
  })

  it('rejects invalid input without asking the person', async () => {
    let asked = false
    const { d, calls } = deps([msg([{ type: 'tool_use', id: 't1', name: 'budgets_set', input: { bad: true } }], 'tool_use'), msg([{ type: 'text', text: 'Fixed.' }], 'end_turn')])
    d.confirm = async () => ((asked = true), true)
    const messages: never[] = [{ role: 'user', content: 'x' } as never]
    await runTurn(messages, d, new AbortController().signal)
    expect(asked).toBe(false)
    expect(calls).toEqual([])
    expect(JSON.stringify(messages[2])).toContain('Invalid input')
  })

  it('never runs a tool call cut off by max_tokens, and stops on refusal', async () => {
    const a = deps([msg([{ type: 'tool_use', id: 't1', name: 'budgets_set', input: {} }], 'max_tokens')])
    expect(await runTurn([{ role: 'user', content: 'x' } as never], a.d, new AbortController().signal)).toBe('max_tokens')
    expect(a.calls).toEqual([])
    const b = deps([msg([], 'refusal')])
    expect(await runTurn([{ role: 'user', content: 'x' } as never], b.d, new AbortController().signal)).toBe('refusal')
  })
})
