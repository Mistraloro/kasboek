import { PUBLIC_OPS, type OpName } from '@shared/contract'

/** The refusal for an operation that needs a login, or null when it may run. Only the login operations work while locked. */
export function lockedRefusal(name: OpName, unlocked: boolean): { ok: false; error: { code: string; message: string } } | null {
  if (unlocked || PUBLIC_OPS.includes(name)) return null
  return { ok: false, error: { code: 'auth.locked', message: 'Kasboek is locked.' } }
}
