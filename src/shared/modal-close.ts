// What a dialog does when the person tries to close it. A click on the dimmed background never
// closes a form by accident; Escape and the close button ask first when something was typed.
export type CloseSource = 'backdrop' | 'escape' | 'button'

export function closeAction(o: { source: CloseSource; dirty?: boolean; closeOnBackdrop?: boolean; dismissible?: boolean }): 'close' | 'confirm' | 'ignore' {
  if (o.dismissible === false) return 'ignore'
  if (o.source === 'backdrop' && !o.closeOnBackdrop) return 'ignore'
  return o.dirty ? 'confirm' : 'close'
}
