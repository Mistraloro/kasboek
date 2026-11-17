import type { ErrorDetails } from '@shared/error-text'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Structured facts about the failure, for a text in the person's language. */
    public readonly details?: ErrorDetails
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * A model's answer was cut off by its output limit. `answered` is false when nothing but reasoning
 * came out, which means the reasoning used up the whole budget (a smaller part would not help).
 */
export class TruncatedError extends AppError {
  constructor(
    message: string,
    public readonly answered: boolean
  ) {
    super('assistant.too_long', message)
    this.name = 'TruncatedError'
  }
}
