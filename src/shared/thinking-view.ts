/** How far from the bottom (px) a scroll position still counts as "at the bottom". */
export const STICK_THRESHOLD_PX = 24

/** True when the view shows the end of the text, so new text should keep it scrolled to the bottom. */
export function stickToBottom(m: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= threshold
}

/** Whether the "jump to latest" button is useful: the text overflows and the view is not at its end. */
export function showJumpToLatest(m: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight > m.clientHeight && !stickToBottom(m, threshold)
}

/** The thinking section is collapsed by default, and only the person opens or closes it (never the stream). */
export const THINKING_START_OPEN = false

export function toggleThinking(open: boolean): boolean {
  return !open
}

/** The label of the thinking section: "Thinking…" while the model works, "Thinking" once done. */
export function thinkingLabelKey(live: boolean): 'assistant.thinkingLive' | 'assistant.thinkingShown' {
  return live ? 'assistant.thinkingLive' : 'assistant.thinkingShown'
}

/** Nothing is shown for models that send no thinking text. */
export function hasThinking(text: string | undefined): text is string {
  return !!text && text.trim().length > 0
}
