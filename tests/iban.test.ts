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

  it('finds an IBAN stuck to letters or digits before it, and one in lower case', () => {
    expect(findIbans('REFNL91ABNA0417164300')).toEqual(['NL91ABNA0417164300'])
    expect(findIbans('MANDATEBE68539007547034')).toEqual(['BE68539007547034'])
    expect(findIbans('REF12NL91ABNA0417164300 end')).toEqual(['NL91ABNA0417164300'])
    expect(findIbans('naar nl91 abna 0417 1643 00 voor')).toEqual(['NL91ABNA0417164300'])
    expect(findIbans('betaling be68539007547034')).toEqual(['BE68539007547034'])
    expect(findIbans('BE68539007547034NL91ABNA0417164300')).toEqual(['BE68539007547034', 'NL91ABNA0417164300'])
  })

  it('masks glued IBANs everywhere the masking is used', () => {
    expect(maskIban('REFNL91ABNA0417164300 ok')).toBe('REFNL…4300 ok')
    expect(maskNumbers('REFNL91ABNA0417164300')).toBe('REFNL…4300')
    expect(maskNumbers('Mandate 864551BE68539007547034XYZ')).toBe('Mandate 864551BE…7034XYZ')
    expect(maskIban('nl91abna0417164300')).toBe('NL…4300')
    expect(maskIban('BE68539007547034NL91ABNA0417164300')).toBe('BE…7034NL…4300')
  })

  it('leaves ordinary words, references and wrong checksums alone', () => {
    for (const text of ['REFNL91ABNA0417164301', 'BE68539007547035', 'REFERENCE2026110512345', 'INVOICE12ABCDEFGHIJK', 'PAYMENT AB12CDEFGHIJKLMNOP', 'Albert Heijn Brussel 03/11', 'REFERENTIENUMMER']) {
      expect(findIbans(text)).toEqual([])
      expect(maskIban(text)).toBe(text)
    }
    expect(maskNumbers('afschrift 2026-11.pdf')).toBe('afschrift 2026-11.pdf')
  })

  // The example IBANs of the registry, one per country in the table of lengths. A wrong length for a country fails here.
  const EXAMPLES = [
    'AD1200012030200359100100', 'AE070331234567890123456', 'AL47212110090000000235698741', 'AT611904300234573201', 'AZ21NABZ00000000137010001944', 'BA391290079401028494',
    'BE68539007547034', 'BG80BNBG96611020345678', 'BH67BMAG00001299123456', 'BR1800360305000010009795493C1', 'BY13NBRB3600900000002Z00AB00', 'CH9300762011623852957',
    'CR05015202001026284066', 'CY17002001280000001200527600', 'CZ6508000000192000145399', 'DE89370400440532013000', 'DK5000400440116243', 'DO28BAGR00000001212453611324',
    'EE382200221020145685', 'EG380019000500000000263180002', 'ES9121000418450200051332', 'FI2112345600000785', 'FO6264600001631634', 'FR1420041010050500013M02606',
    'GB29NWBK60161331926819', 'GE29NB0000000101904917', 'GI75NWBK000000007099453', 'GL8964710001000206', 'GR1601101250000000012300695', 'GT82TRAJ01020000001210029690',
    'HR1210010051863000160', 'HU42117730161111101800000000', 'IE29AIBK93115212345678', 'IL620108000000099999999', 'IS140159260076545510730339', 'IT60X0542811101000000123456',
    'JO94CBJO0010000000000131000302', 'KW81CBKU0000000000001234560101', 'KZ86125KZT5004100100', 'LB62099900000001001901229114', 'LI21088100002324013AA', 'LT121000011101001000',
    'LU280019400644750000', 'LV80BANK0000435195001', 'MC5811222000010123456789030', 'MD24AG000225100013104168', 'ME25505000012345678951', 'MK07250120000058984',
    'MR1300020001010000123456753', 'MT84MALT011000012345MTLCAST001S', 'MU17BOMM0101101030300200000MUR', 'NL91ABNA0417164300', 'NO9386011117947', 'PK36SCBL0000001123456702',
    'PL61109010140000071219812874', 'PS92PALS000000000400123456702', 'PT50000201231234567890154', 'QA58DOHB00001234567890ABCDEFG', 'RO49AAAA1B31007593840000', 'RS35260005601001611379',
    'SA0380000000608010167519', 'SC18SSCB11010000000000001497USD', 'SE4550000000058398257466', 'SI56263300012039086', 'SK3112000000198742637541', 'SM86U0322509800000000270100',
    'ST68000100010051845310112', 'SV62CENR00000000000000700025', 'TL380080012345678910157', 'TN5910006035183598478831', 'TR330006100519786457841326', 'UA213223130000026007233566001',
    'VA59001123000012345678', 'VG96VPVG0000012345678901', 'XK051212012345678906'
  ]
  const grouped = (iban: string): string => iban.replace(/(.{4})(?=.)/g, '$1 ')

  it.each(EXAMPLES)('finds and masks the example IBAN %s, written plain, in groups and glued to text', (iban) => {
    expect(validIban(iban)).toBe(true)
    const last4 = iban.slice(-4)
    const mask = `${iban.slice(0, 2)}…${last4}`
    expect(findIbans(`naar ${iban} voor huur`)).toEqual([iban])
    expect(maskIban(`naar ${iban} voor huur`)).toBe(`naar ${mask} voor huur`)
    expect(findIbans(`naar ${grouped(iban)} voor huur`)).toEqual([iban])
    expect(maskIban(`naar ${grouped(iban)}.`)).toBe(`naar ${mask}.`)
    expect(findIbans(`REF${iban}`)).toEqual([iban])
    expect(maskNumbers(`REF${iban}`)).toBe(`REF${mask}`)
  })
})
