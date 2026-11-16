import { describe, expect, it } from 'vitest'
import { revealedAfter, type RevealEvent } from '@shared/password-reveal'

describe('hold to reveal a password', () => {
  it('shows while the pointer is down and hides on release, cancel or leaving the button', () => {
    expect(revealedAfter(false, { kind: 'pointerdown' })).toBe(true)
    for (const kind of ['pointerup', 'pointercancel', 'pointerleave'] as const) expect(revealedAfter(true, { kind })).toBe(false)
  })

  it('shows while Space or Enter is held and hides when it is released', () => {
    for (const key of [' ', 'Enter']) {
      expect(revealedAfter(false, { kind: 'keydown', key })).toBe(true)
      expect(revealedAfter(true, { kind: 'keyup', key })).toBe(false)
    }
  })

  it('hides on Escape and ignores other keys', () => {
    expect(revealedAfter(true, { kind: 'keydown', key: 'Escape' })).toBe(false)
    expect(revealedAfter(false, { kind: 'keydown', key: 'a' })).toBe(false)
    expect(revealedAfter(true, { kind: 'keydown', key: 'a' })).toBe(true)
    expect(revealedAfter(true, { kind: 'keyup', key: 'a' })).toBe(true)
  })

  it('hides when focus, the window or the app is lost', () => {
    const events: RevealEvent[] = [{ kind: 'blur' }, { kind: 'window-blur' }, { kind: 'visibility', hidden: true }, { kind: 'lock' }]
    for (const e of events) expect(revealedAfter(true, e)).toBe(false)
  })

  it('never reveals by itself when the window becomes visible again', () => {
    expect(revealedAfter(false, { kind: 'visibility', hidden: false })).toBe(false)
  })
})
