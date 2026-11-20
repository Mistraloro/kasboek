import type { OpName } from '@shared/contract'

/**
 * Operations that only exist for the assistant and everything that sends text to an AI provider. While the assistant is switched off
 * (Settings → Assistant → "Use the assistant") each of them is refused with `assistant.disabled`, whoever asks. The connected Claude apps (MCP)
 * are a separate integration with their own switch and are not among them.
 */
export const ASSISTANT_OPS: readonly OpName[] = [
  'assistant.status',
  'assistant.setKey',
  'assistant.models',
  'assistant.clearKey',
  'assistant.addProvider',
  'assistant.renameProvider',
  'assistant.removeProvider',
  'assistant.configure',
  'assistant.send',
  'assistant.confirm',
  'assistant.stop',
  'assistant.reset',
  'import.assist',
  'import.assistPreview',
  'import.assistStatus',
  'import.assistCancel',
  'import.pdfAssistPreview',
  'import.pdfAssist',
  'insights.preview',
  'insights.run',
  'insights.cancel',
  'insights.status',
  'memory.list',
  'memory.remember',
  'memory.add',
  'memory.update',
  'memory.forget',
  'memory.forgetAll',
  'memory.setEnabled'
]

/** `assistant.configure` also holds the switch of the Claude apps (MCP), which stays reachable; nothing else in it does. */
const MCP_ONLY_PATCH = new Set(['mcpEnabled'])

const refusal = { ok: false as const, error: { code: 'assistant.disabled', message: 'The assistant is turned off. Turn it on in Settings → Assistant.' } }

/**
 * The refusal for an operation that needs the assistant, or null when it may run. `summary.review` (the facts for a month review) is
 * offered to the Claude apps over MCP too, so it is only refused for the app's own pages, which have no use for it without the assistant.
 */
export function assistantRefusal(name: OpName, actor: 'user' | 'assistant' | 'system', input: unknown, enabled: boolean): typeof refusal | null {
  if (enabled) return null
  if (name === 'summary.review') return actor === 'assistant' ? null : refusal
  if (!ASSISTANT_OPS.includes(name)) return null
  if (name === 'assistant.configure' && input && typeof input === 'object' && Object.keys(input).length > 0 && Object.keys(input).every((k) => MCP_ONLY_PATCH.has(k))) return null
  return refusal
}
