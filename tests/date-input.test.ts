import { describe, expect, it } from 'vitest'
import { DATE_PATTERNS, DEFAULT_FORMATS, checkDateText, formatDate, parseDate, type DatePattern, type FormatPrefs } from '@shared/format'

const f = (date: DatePattern): FormatPrefs => ({ ...DEFAULT_FORMATS, date })

describe('parseDate', () => {
  it('reads a date in the chosen order', () => {
    expect(parseDate('05/01/2026', f('DD/MM/YYYY'))).toBe('2026-01-05')
    expect(parseDate('05/01/2026', f('MM/DD/YYYY'))).toBe('2026-05-01')
    expect(parseDate('2026-01-05', f('YYYY-MM-DD'))).toBe('2026-01-05')
    expect(parseDate('5.1.2026', f('D.M.YYYY'))).toBe('2026-01-05')
    expect(parseDate('2026 Jan 5', f('YYYY MMM D'))).toBe('2026-01-05')
  })

  it('round-trips every supported pattern back to ISO', () => {
    for (const pattern of DATE_PATTERNS) {
      for (const iso of ['2026-01-05', '2026-12-31', '2024-02-29']) {
        for (const language of ['en', 'nl', 'de']) {
          expect(parseDate(formatDate(iso, f(pattern), language), f(pattern), language), `${pattern} ${language} ${iso}`).toBe(iso)
        }
      }
    }
  })

  it('accepts missing leading zeros, spare spaces and a plain ISO date', () => {
    expect(parseDate('  5/1/2026 ', f('DD/MM/YYYY'))).toBe('2026-01-05')
    expect(parseDate('Jan 5,2026', f('MMM D, YYYY'))).toBe('2026-01-05')
    expect(parseDate('2026-01-05', f('DD/MM/YYYY'))).toBe('2026-01-05')
  })

  it('reads month names in the interface language, long or short', () => {
    expect(parseDate('5 maart 2026', f('D MMMM YYYY'), 'nl')).toBe('2026-03-05')
    expect(parseDate('5 mrt 2026', f('D MMM YYYY'), 'nl')).toBe('2026-03-05')
    expect(parseDate('5 MARCH 2026', f('D MMMM YYYY'), 'en')).toBe('2026-03-05')
    expect(parseDate('5 Smarch 2026', f('D MMMM YYYY'), 'en')).toBeNull()
  })

  it('treats two-digit years as 20YY', () => {
    expect(parseDate('05/01/26', f('DD/MM/YY'))).toBe('2026-01-05')
    expect(parseDate('01/05/99', f('MM/DD/YY'))).toBe('2099-01-05')
    expect(parseDate('26-01-05', f('YY-MM-DD'))).toBe('2026-01-05')
  })

  it('knows leap days', () => {
    expect(parseDate('29/02/2024', f('DD/MM/YYYY'))).toBe('2024-02-29')
    expect(parseDate('29/02/2026', f('DD/MM/YYYY'))).toBeNull()
    expect(parseDate('29/02/2100', f('DD/MM/YYYY'))).toBeNull()
    expect(parseDate('29/02/2000', f('DD/MM/YYYY'))).toBe('2000-02-29')
  })

  it('rejects what is not a date', () => {
    for (const bad of ['', '  ', 'abc', '32/01/2026', '00/01/2026', '15/13/2026', '31/04/2026', '5/1', '05/01/2026x', '05-01-2026', '1/1/0000']) {
      expect(parseDate(bad, f('DD/MM/YYYY')), bad).toBeNull()
    }
    expect(parseDate('13/01/2026', f('MM/DD/YYYY'))).toBeNull()
  })
})

describe('checkDateText', () => {
  it('gives the ISO date for good input and nothing for empty input', () => {
    expect(checkDateText('05/01/2026', f('DD/MM/YYYY'))).toEqual({ iso: '2026-01-05', problem: null })
    expect(checkDateText('', f('DD/MM/YYYY'))).toEqual({ iso: '', problem: null })
  })

  it('flags text that is not a date', () => {
    expect(checkDateText('2026-01-05', f('MM/DD/YYYY')).problem).toBeNull()
    expect(checkDateText('31/02/2026', f('DD/MM/YYYY'))).toEqual({ iso: '', problem: 'invalid' })
  })

  it('flags dates after the latest allowed day', () => {
    expect(checkDateText('06/01/2026', f('DD/MM/YYYY'), 'en', '2026-01-05')).toEqual({ iso: '', problem: 'tooLate' })
    expect(checkDateText('05/01/2026', f('DD/MM/YYYY'), 'en', '2026-01-05')).toEqual({ iso: '2026-01-05', problem: null })
  })
})
