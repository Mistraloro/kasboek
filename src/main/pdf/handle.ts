/**
 * The cancel handle of the PDF read in progress. One read at a time: a second request is refused without
 * touching the handle of the first, and a read only ever clears its own handle.
 */
export interface ReadSlot {
  /** Takes the slot for a new read; null when a read already holds it. */
  claim(): AbortController | null
  /** Frees the slot, but only for the read that holds it. */
  release(controller: AbortController): void
  /** Stops the read in progress (Cancel, or the app locking). */
  abort(): void
}

export function createReadSlot(): ReadSlot {
  let current: AbortController | null = null
  return {
    claim() {
      if (current) return null
      current = new AbortController()
      return current
    },
    release(controller) {
      if (current === controller) current = null
    },
    abort() {
      current?.abort()
    }
  }
}
