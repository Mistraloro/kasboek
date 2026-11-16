import { describe, expect, it } from 'vitest'
import { DEFAULT_FORMATS, FORMAT_PRESETS, formatDate, formatMoney, matchingPreset, normalizeFormats } from '@shared/format'

describe('format presets for the welcome window', () => {
  it('are valid, and each looks different', () => {
    for (const p of FORMAT_PRESETS) expect(normalizeFormats(p.formats)).toEqual(p.formats)
    const looks = FORMAT_PRESETS.map((p) => `${formatMoney(-123456, 'EUR', p.formats)} ${formatDate('2026-12-31', p.formats)} ${p.formats.time}`)
    expect(new Set(looks).size).toBe(FORMAT_PRESETS.length)
  })

  it('recognises the preset that matches, and none for a mix', () => {
    expect(matchingPreset(DEFAULT_FORMATS)).toBe('eu')
    expect(matchingPreset(FORMAT_PRESETS.find((p) => p.id === 'us')!.formats)).toBe('us')
    expect(matchingPreset({ ...DEFAULT_FORMATS, negative: 'parentheses' })).toBeNull()
  })
})
