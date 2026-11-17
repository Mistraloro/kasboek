export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string
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
