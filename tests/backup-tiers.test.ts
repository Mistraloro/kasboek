import { describe, expect, it } from 'vitest'
import { planRetention, timeFromName } from '@core/backup-tiers'

const H = 3_600_000
const D = 24 * H

describe('backup retention tiers', () => {
  it('keeps all of the last day, one per day for 30 days, one per month for a year', () => {
    const now = Date.UTC(2026, 10, 13, 12)
    const e = (name: string, ago: number) => ({ name, time: now - ago })
    const entries = [
      e('r1', 1 * H), e('r2', 5 * H), e('r3', 23 * H),
      e('d1-new', 2 * D), e('d1-old', 2 * D + 2 * H), e('d2', 10 * D),
      e('m-a', 40 * D), e('m-a-older', 41 * D), e('m-b', 200 * D),
      e('ancient', 400 * D)
    ]
    const { keep, remove } = planRetention(entries, now)
    expect([...keep.entries()].filter(([, t]) => t === 'recent').map(([n]) => n).sort()).toEqual(['r1', 'r2', 'r3'])
    expect(keep.get('d1-new')).toBe('daily')
    expect(keep.has('d1-old')).toBe(false)
    expect(keep.get('d2')).toBe('daily')
    expect(keep.get('m-a')).toBe('monthly')
    expect(keep.get('m-b')).toBe('monthly')
    expect(remove.sort()).toEqual(['ancient', 'd1-old', 'm-a-older'].sort())
  })
  it('reads times from backup names', () => {
    expect(new Date(timeFromName('kasboek-backup-2026-11-13_092130.kasboek')!).getMinutes()).toBe(21)
    expect(timeFromName('other.kasboek')).toBeNull()
  })
})
