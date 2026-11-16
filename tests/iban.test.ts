import { describe, expect, it } from 'vitest'
import { findIbans, maskIban, maskNumbers, validIban } from '@shared/iban'

describe('IBAN helpers', () => {
  it('checks the checksum', () => {
    expect(validIban('BE68539007547034')).toBe(true)
    expect(validIban('BE68539007547035')).toBe(false)
  })

  it('finds valid IBANs, written in groups or stuck to other text, each once', () => {
    expect(findIbans('Naar BE68 5390 0754 7034 voor huur')).toEqual(['BE68539007547034'])
    expect(findIbans('MANDAAT 864551BE68539007547034XYZ')).toEqual(['BE68539007547034'])
    expect(findIbans('BE68 5390 0754 7034 en NL91 ABNA 0417 1643 00, BE68539007547034')).toEqual(['BE68539007547034', 'NL91ABNA0417164300'])
    expect(findIbans('REF AB12CDEFGHIJKLMNOP')).toEqual([])
    expect(findIbans('geen rekening')).toEqual([])
  })

  it('masks IBANs and long digit runs', () => {
    expect(maskNumbers('Afschrift BE68 5390 0754 7034.pdf')).toBe('Afschrift BE…7034.pdf')
    expect(maskNumbers('statement_5390075470341.pdf')).toBe('statement_…0341.pdf')
    expect(maskNumbers('card 4111 1111 1111 1111 paid')).toBe('card …1111 paid')
    expect(maskNumbers('afschrift 2026-11.pdf')).toBe('afschrift 2026-11.pdf')
    expect(maskNumbers(maskIban('BE68539007547034'))).toBe('BE…7034')
  })
})
