/**
 * Hold-to-reveal for password fields: the text is only visible while the person keeps pressing the
 * eye button. This decides, for every event the field can see, whether the text is shown afterwards.
 * Pure, so it can be tested.
 */

export type RevealEvent =
  | { kind: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointerleave' }
  | { kind: 'keydown' | 'keyup'; key: string }
  /** The eye button or the field lost focus. */
  | { kind: 'blur' }
  /** The window lost focus. */
  | { kind: 'window-blur' }
  | { kind: 'visibility'; hidden: boolean }
  /** The app locked or the field is going away. */
  | { kind: 'lock' }

const HOLD_KEYS = [' ', 'Spacebar', 'Enter']

/** Whether the password is shown after `event`, given whether it was shown before. */
export function revealedAfter(revealed: boolean, event: RevealEvent): boolean {
  switch (event.kind) {
    case 'pointerdown':
      return true
    case 'keydown':
      if (event.key === 'Escape') return false
      return HOLD_KEYS.includes(event.key) ? true : revealed
    case 'keyup':
      return HOLD_KEYS.includes(event.key) ? false : revealed
    case 'visibility':
      return event.hidden ? false : revealed
    case 'pointerup':
    case 'pointercancel':
    case 'pointerleave':
    case 'blur':
    case 'window-blur':
    case 'lock':
      return false
  }
}
