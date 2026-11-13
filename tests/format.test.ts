import { describe, expect, it } from 'vitest'
import { parseAmount } from '@shared/amount'
import { DEFAULT_FORMATS, formatDate, formatDateTime, formatMoney, formatNumber, formatsFromLegacyLocale, normalizeFormats, type FormatPrefs } from '@shared/format'

const f = (p: Partial<FormatPrefs> = {}): FormatPrefs => ({ ...DEFAULT_FORMATS, ...p })

describe('formats', () => {
  it('formats numbers with each separator choice', () => {
    expect(formatNumber(1234567.891, f())).toBe('1.234.567,89')
    expect(formatNumber(1234567.891, f({ decimal: '.', group: ',' }))).toBe('1,234,567.89')
    expect(formatNumber(1234567.5, f({ decimal: '.', group: "'" }))).toBe("1'234'567.50")
    expect(formatNumber(1234567.5, f({ group: ' ' }))).toBe('1 234 567,50')
    expect(formatNumber(1234567.5, f({ group: '' }))).toBe('1234567,50')
    expect(formatNumber(12345678, f({ decimal: '.', group: ',', grouping: 'indian' }), 0)).toBe('1,23,45,678')
    expect(formatNumber(999, f(), 0)).toBe('999')
  })

  it('places the currency and the minus sign as chosen', () => {
    expect(formatMoney(-123456, 'EUR', f())).toBe('−1.234,56 €')
    expect(formatMoney(123456, 'EUR', f({ currencyPosition: 'before', decimal: '.', group: ',' }))).toBe('€1,234.56')
    expect(formatMoney(-123456, 'USD', f({ currencyPosition: 'before', negative: 'minus-after-symbol' }))).toBe('$−1.234,56')
    expect(formatMoney(-123456, 'EUR', f({ negative: 'parentheses' }))).toBe('(1.234,56 €)')
    expect(formatMoney(5000, 'EUR', f({ currencyStyle: 'code', currencyPosition: 'before' }))).toBe('EUR 50,00')
    expect(formatMoney(-0.4, 'EUR', f())).toBe('0,00 €')
    expect(formatMoney(123456, 'JPY', f())).toBe('1.235 ¥')
  })

  it('formats dates with any pattern, without time zone shifts', () => {
    expect(formatDate('2026-01-05', f())).toBe('05/01/2026')
    expect(formatDate('2026-01-05', f({ date: 'MM/DD/YYYY' }))).toBe('01/05/2026')
    expect(formatDate('2026-01-05', f({ date: 'YYYY-MM-DD' }))).toBe('2026-01-05')
    expect(formatDate('2026-01-05', f({ date: 'D.M.YYYY' }))).toBe('5.1.2026')
    expect(formatDate('2026-01-05', f({ date: 'DD/MM/YY' }))).toBe('05/01/26')
    expect(formatDate('2026-01-05', f({ date: 'D MMMM YYYY' }), 'en')).toBe('5 January 2026')
    expect(formatDate('2026-01-05', f({ date: 'MMM D, YYYY' }), 'en')).toBe('Jan 5, 2026')
    expect(formatDate('2026-03-05', f({ date: 'D MMMM YYYY' }), 'nl')).toBe('5 maart 2026')
    expect(formatDateTime(new Date(2026, 0, 5, 14, 7), f({ time: '12h' }))).toBe('05/01/2026 2:07 PM')
    expect(formatDateTime(new Date(2026, 0, 5, 0, 7), f({ time: '12h' }))).toBe('05/01/2026 12:07 AM')
    expect(formatDateTime(new Date(2026, 0, 5, 9, 7), f())).toBe('05/01/2026 09:07')
  })

  it('keeps separators from clashing and drops unknown values', () => {
    expect(normalizeFormats({ decimal: '.', group: '.' }).group).toBe(',')
    expect(normalizeFormats({ date: 'nonsense' as never }).date).toBe(DEFAULT_FORMATS.date)
    expect(formatsFromLegacyLocale('en-US')).toMatchObject({ decimal: '.', date: 'MM/DD/YYYY', time: '12h' })
    expect(formatsFromLegacyLocale('nl-BE')).toEqual(DEFAULT_FORMATS)
  })

  it('reads typed amounts using the chosen decimal mark when unclear', () => {
    expect(parseAmount('1,234', 'auto', '.')).toBe(123400)
    expect(parseAmount('1.234', 'auto', ',')).toBe(123400)
    expect(parseAmount('12,5', 'auto', '.')).toBe(1250)
    expect(parseAmount('12', 'auto', '.')).toBe(1200)
  })
})
