import { describe, expect, it } from 'vitest'
import { THINKING_START_OPEN, hasThinking, showJumpToLatest, stickToBottom, thinkingLabelKey, toggleThinking } from '../src/shared/thinking-view'

describe('stickToBottom', () => {
  it('sticks when at the very bottom', () => {
    expect(stickToBottom({ scrollTop: 300, clientHeight: 200, scrollHeight: 500 })).toBe(true)
  })
  it('sticks within the threshold', () => {
    expect(stickToBottom({ scrollTop: 280, clientHeight: 200, scrollHeight: 500 })).toBe(true)
  })
  it('lets go once scrolled up', () => {
    expect(stickToBottom({ scrollTop: 100, clientHeight: 200, scrollHeight: 500 })).toBe(false)
  })
  it('sticks when the text does not overflow', () => {
    expect(stickToBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 120 })).toBe(true)
  })
})

describe('showJumpToLatest', () => {
  it('only when overflowing and scrolled up', () => {
    expect(showJumpToLatest({ scrollTop: 0, clientHeight: 200, scrollHeight: 500 })).toBe(true)
    expect(showJumpToLatest({ scrollTop: 300, clientHeight: 200, scrollHeight: 500 })).toBe(false)
    expect(showJumpToLatest({ scrollTop: 0, clientHeight: 200, scrollHeight: 150 })).toBe(false)
  })
})

describe('collapsed state', () => {
  it('starts collapsed and toggles', () => {
    expect(THINKING_START_OPEN).toBe(false)
    expect(toggleThinking(false)).toBe(true)
    expect(toggleThinking(true)).toBe(false)
  })
})

describe('labels and presence', () => {
  it('picks the label by state', () => {
    expect(thinkingLabelKey(true)).toBe('assistant.thinkingLive')
    expect(thinkingLabelKey(false)).toBe('assistant.thinkingShown')
  })
  it('shows nothing without text', () => {
    expect(hasThinking(undefined)).toBe(false)
    expect(hasThinking('  \n ')).toBe(false)
    expect(hasThinking('hmm')).toBe(true)
  })
})
