/**
 * What an error from the main process needs to be shown in the person's language: which text
 * (`errors.<code>`, or a text per kind for provider failures) and the values its placeholders need.
 */

/** Why a call to the assistant's provider failed. */
export type ProviderFailureKind = 'network' | 'auth' | 'rate_limit' | 'server' | 'model_not_found' | 'bad_request' | 'unknown'

export const PROVIDER_FAILURE_KINDS: readonly ProviderFailureKind[] = ['network', 'auth', 'rate_limit', 'server', 'model_not_found', 'bad_request', 'unknown']

/** Structured details of a failed call to the provider. The message is the provider's own, short and untranslated. */
export interface ErrorDetails {
  kind: ProviderFailureKind
  /** HTTP status; 0 when the provider could not be reached. */
  status: number
  message: string
}

/** Details for a failure that is not the provider's: only what the error itself says, kept short. */
export const unknownFailure = (err: unknown): ErrorDetails => ({ kind: 'unknown', status: 0, message: err instanceof Error ? err.message.slice(0, 200) : '' })

/** The assistant in use, as far as it is known. */
export interface ErrorProvider {
  name: string
  /** The company behind it; null for one that runs on this computer. */
  company: string | null
}

/** The key of the text for an error: failures of the provider have one text per kind. */
export function errorKey(code: string, details?: ErrorDetails): string {
  if (code === 'assistant.failed' && details) return `errors.assistant_failed_${details.kind}`
  return `errors.${code.replace(/\./g, '_')}`
}

/**
 * The values for every placeholder an error text can have, so none is ever shown raw. `neutral` stands
 * for the assistant when no provider is set; `detail` is the provider's message in brackets, or nothing.
 */
export function errorVars(provider: ErrorProvider | null, neutral: string, details?: ErrorDetails): { ai: string; aiCompany: string; status: string; detail: string } {
  const ai = provider?.name || neutral
  return { ai, aiCompany: provider?.company || ai, status: details ? String(details.status) : '', detail: details?.message ? ` (${details.message})` : '' }
}
