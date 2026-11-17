import { describe, expect, it } from 'vitest'
import { contract, MILESTONE_NAME, PUBLIC_OPS } from '../src/shared/contract'
import { lockedRefusal } from '../src/main/lock-guard'

const parse = (v: unknown) => contract['app.milestone'].input.safeParse(v)

describe('app.milestone operation', () => {
  it('accepts a short lower-case name and a time', () => {
    expect(parse({ name: 'prefs loaded', ms: 1234.5 }).success).toBe(true)
    expect(parse({ name: 'a-b_c 1', ms: 0 }).success).toBe(true)
  })
  it('refuses anything that could carry data or break the log', () => {
    for (const name of ['', 'Prefs', 'a'.repeat(41), 'line\nbreak', 'ünïcode', 'a/b', 'a.b', 'name: x', '😀']) {
      expect(parse({ name, ms: 1 }).success, JSON.stringify(name)).toBe(false)
    }
    expect(MILESTONE_NAME.test('a'.repeat(40))).toBe(true)
  })
  it('refuses a time that is not a plain number', () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, 1e12]) expect(parse({ name: 'x', ms }).success).toBe(false)
  })
  it('refuses other fields', () => {
    expect(parse({ name: 'x', ms: 1, extra: 1 }).success).toBe(false)
  })
  it('works before unlock, like app.ready', () => {
    expect(PUBLIC_OPS).toContain('app.milestone')
    expect(lockedRefusal('app.milestone', false)).toBeNull()
  })
})
