import { describe, expect, it } from 'vitest'
import { decideGraphics, isGpuFailure } from '../src/shared/graphics'

const base = { choice: 'auto' as const, failedBefore: false, platform: 'win32', arch: 'x64', disableGpuFlag: false }

describe('decideGraphics', () => {
  it('uses the graphics card by default', () => {
    expect(decideGraphics(base)).toEqual({ hardware: true, reason: null })
    expect(decideGraphics({ ...base, platform: 'darwin', arch: 'arm64' }).hardware).toBe(true)
    expect(decideGraphics({ ...base, platform: 'linux', arch: 'arm64' }).hardware).toBe(true)
  })
  it('draws in software on Windows on ARM, unless asked otherwise', () => {
    expect(decideGraphics({ ...base, arch: 'arm64' })).toEqual({ hardware: false, reason: 'windows-arm' })
    expect(decideGraphics({ ...base, arch: 'arm64', choice: 'on' }).hardware).toBe(true)
  })
  it('remembers a failure only for the automatic choice', () => {
    expect(decideGraphics({ ...base, failedBefore: true })).toEqual({ hardware: false, reason: 'failed' })
    expect(decideGraphics({ ...base, failedBefore: true, choice: 'on' }).hardware).toBe(true)
  })
  it('follows the setting and the --disable-gpu flag', () => {
    expect(decideGraphics({ ...base, choice: 'off' })).toEqual({ hardware: false, reason: 'setting' })
    expect(decideGraphics({ ...base, choice: 'on', disableGpuFlag: true })).toEqual({ hardware: false, reason: 'flag' })
  })
})

describe('isGpuFailure', () => {
  it('counts crashes, not normal exits', () => {
    expect(isGpuFailure('crashed')).toBe(true)
    expect(isGpuFailure('launch-failed')).toBe(true)
    expect(isGpuFailure('clean-exit')).toBe(false)
    expect(isGpuFailure('killed')).toBe(false)
  })
})
