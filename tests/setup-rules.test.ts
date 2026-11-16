import { describe, expect, it } from 'vitest'
import { mayRefreshOnFocus, recoveryKeyConfirmed, recoveryKeyTail, type SetupStep } from '@shared/setup-rules'

const KEY = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567'

describe('first-run screen', () => {
  it('re-checks Windows Hello on focus only on the first step', () => {
    expect(mayRefreshOnFocus('choose')).toBe(true)
    const later: SetupStep[] = ['password', 'import', 'recovery', 'twofactor']
    for (const step of later) expect(mayRefreshOnFocus(step)).toBe(false)
  })

  it('takes the last group of the recovery key', () => {
    expect(recoveryKeyTail(KEY)).toBe('4567')
  })

  it('keeps Continue disabled until the box is ticked and the last group is typed', () => {
    expect(recoveryKeyConfirmed(KEY, false, '')).toBe(false)
    expect(recoveryKeyConfirmed(KEY, false, '4567')).toBe(false)
    expect(recoveryKeyConfirmed(KEY, true, '')).toBe(false)
    expect(recoveryKeyConfirmed(KEY, true, '456')).toBe(false)
    expect(recoveryKeyConfirmed(KEY, true, '4568')).toBe(false)
    expect(recoveryKeyConfirmed(KEY, true, '4567')).toBe(true)
  })

  it('never confirms without a key', () => {
    expect(recoveryKeyConfirmed('', true, '')).toBe(false)
  })
})
