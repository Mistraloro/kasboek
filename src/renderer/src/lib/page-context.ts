import { useEffect, useSyncExternalStore } from 'react'
import type { PageContext } from '@shared/page-context'

/** What the open page says about itself; the assistant panel reads it when a message is sent. */
let current: PageContext | null = null
const listeners = new Set<() => void>()
const set = (next: PageContext | null): void => {
  current = next
  listeners.forEach((l) => l())
}

/** Called by a page with what it shows (from its data and state). Cleared when the page closes. */
export function usePublishPageContext(ctx: PageContext | null): void {
  const key = JSON.stringify(ctx)
  useEffect(() => set(ctx), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => set(null), [])
}

export function usePageContext(): PageContext | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}
