import { describe, expect, it } from 'vitest'
import { lazy } from '../src/main/lazy'

describe('lazy module', () => {
  it('loads on first use only, also when asked twice at once', async () => {
    let loads = 0
    const m = lazy(async () => {
      loads++
      return { n: 1 }
    })
    expect(loads).toBe(0)
    expect(m.loaded()).toBeNull()
    const [a, b] = await Promise.all([m.get(), m.get()])
    expect(a).toBe(b)
    expect(loads).toBe(1)
    expect(m.loaded()).toBe(a)
    await m.get()
    expect(loads).toBe(1)
  })

  it('tries again after a failed load', async () => {
    let calls = 0
    const m = lazy(async () => {
      if (++calls === 1) throw new Error('not found')
      return 'ok'
    })
    await expect(m.get()).rejects.toThrow('not found')
    expect(m.loaded()).toBeNull()
    await expect(m.get()).resolves.toBe('ok')
  })
})
