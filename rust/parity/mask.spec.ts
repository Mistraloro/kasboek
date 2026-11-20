// Privacy masking parity: maskIban, maskNumbers, maskContacts, maskPrivate and cutText of src/shared/iban.ts against the Rust crate
// kb-rules (through its dev driver kb-rules-cli) on invented strings: identical output, character for character.
// KB_TS_ROOT may point at a checkout whose src/ is the TypeScript to compare with (the release branch).
// Needs: cargo build -p kb-rules --features parity (KB_RULES_BIN overrides the path; the binary has required-features = ["parity"]).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cutText, maskContacts, maskIban, maskNumbers, maskPrivate } from '@shared/iban'

const exe = process.platform === 'win32' ? '.exe' : ''
const candidates = ['release', 'debug'].map((p) => resolve(import.meta.dirname, `../target/${p}/kb-rules-cli${exe}`))
const BIN = process.env.KB_RULES_BIN ?? candidates.find((c) => existsSync(c)) ?? candidates[0]!

// All data here is invented. The IBANs are the published example numbers of the IBAN standard.
const OWN = 'BE68539007547034'
const OTHER = 'NL91ABNA0417164300'
const SPACED = 'NL91 ABNA 0417 1643 00'
const CARD = '5412 7512 3412 3456'
const MAIL = 'ilse.vermeulen@example.test'
const PHONE = '+32 475 12 34 56'

const texts: string[] = [
  '',
  'plain text without anything to hide',
  OWN,
  OTHER,
  SPACED,
  OTHER.toLowerCase(),
  `REF${OTHER}`,
  `${OTHER}${OWN}`,
  `${OWN} ${OTHER}`,
  `NL91.ABNA.0417.1643.00 and NL91-ABNA-0417-1643-00 and NL91/ABNA/0417/1643/00`,
  'NL91 ABNA 0417 1643 00',
  'NL91 ABNA\n0417 1643\t00',
  'NL91​ABNA0417164300',
  'ＮＬ９１ＡＢＮＡ０４１７１６４３００',
  'NL91ABNA0417164301',
  'XX00 1234 5678 9012 3456',
  'GB82 WEST 1234 5698 7654 32',
  'DE89 3704 0044 0532 0130 00',
  'keep …1234 and NL…4300 as they are',
  CARD,
  '5412751234123456',
  '5412-7512-3412-3456',
  '5412.7512.3412.3456',
  '5412/7512/3412/3456',
  `card ${CARD} paid`,
  `${CARD} 2026-10-01`,
  `${CARD} 01-10-2026 02-10-2026`,
  '4111 1111 1111 1111 2026/10/01',
  '123456789012',
  '1234567890123',
  '12 34 56',
  'on 2026-10-01 and 01.10.2026 and 01/10/2026 and 2026.10.01',
  '2026-13-01 2026-10-32 1899-10-01',
  'paid 1.234,50 and 1,234.50 and 12.345.678,9 and 1.234.567.890',
  'amount 1.234 and 1.2345',
  '99.999.999,99 and 123.456.789',
  '1.234,567',
  MAIL,
  `mail ${MAIL}, other <a.b@c.example> or (x@y.zz)`,
  'a@b and x@y.z. and @c.d and e@.f and g@h.',
  'a@b.c@d.e',
  `${'x'.repeat(150)}@example.test`,
  `user@${'d'.repeat(300)}.test`,
  PHONE,
  '+32475123456',
  '0032 475 12 34 56',
  'abc0032 475 12 34 56',
  'x 00 12 and +1 and +12345',
  '(+32) 475 12 34 56 and +31 (0)20 123 45 67',
  'raise of +1.234.567 and +1.234 and +123,456,789',
  '+32 475 12 34 56 01-10-2026',
  '+1234567 2026-10-01',
  '+1234567890123456789012345678901234567890',
  `pay ${SPACED} or call ${PHONE}, mail ${MAIL}`,
  `Card ${CARD} Shop, mail ${MAIL}, call ${PHONE}, to ${SPACED}`,
  `${MAIL} ${PHONE}`,
  'two  spaces and\ta tab',
  'em—dash and −minus ‐ hyphen',
  '­ soft⁠ hyphen ﻿ bom',
  'café é́ emoji 😀 text',
  '① ½ ﬁ ligature',
  `ref ${OTHER} ${'a'.repeat(100)} ${CARD}`,
  `${'a'.repeat(60)} ${OTHER} tail`,
  `${'a'.repeat(60)} ${CARD} tail`,
  `${'a'.repeat(58)} ${PHONE} tail`,
  `${'b'.repeat(28)} ${SPACED} tail ${MAIL}`,
  `${'c'.repeat(30)}${OWN}${'d'.repeat(30)}`,
  `${'e'.repeat(120)} ${OTHER}`,
  `${'e'.repeat(10)} ${CARD} ${CARD}`,
  `${'f'.repeat(9)}1234 5678 9012 3456 7890`,
  '1 2 3 4 5 6 7 8 9 0 1 2 3',
  '1.2.3.4.5.6.7.8.9.0.1.2.3',
  '12345678901234567890',
  '12345678901234567890 2026-10-01 2026-10-02',
  '2026-10-01 2026-10-02 12345678901234567',
  'Klantnummer 4455667 Kerkstraat 12 8000 Gent',
  'ABCD1234567890123456789012345',
  'ZZ12 ABCD EFGH IJKL MNOP QR',
  'AB12345678901234567',
  'GB82WEST12345698765432 GB82 WEST 1234 5698 7654 33',
  'a'.repeat(200),
  '1'.repeat(40),
  `${'1'.repeat(14)}.${'2'.repeat(14)}`,
  '@ @@ @@@',
  '+ ++ +++',
  '00 000 0000000000',
  '+0000000 +00000000',
  '+1.234.567 2026-10-01',
  '+12.345,678',
  '€ 1.234,56 – 2026-10-01 – NL91 ABNA 0417 1643 00',
  'x…y…'
]

interface Out {
  iban: string
  numbers: string
  contacts: string
  private: string
  cut: string | null
}
// Each text with no max, and with a few that cut it (shorter than the text, longer, and at the length of an IBAN).
const MAXES = [null, 5, 20, 31, 60, 400]
const cases = texts.flatMap((text) => MAXES.map((max) => ({ text, max })))

describe('privacy masking', () => {
  it('gives the same text in TS and Rust', () => {
    const rust = JSON.parse(execFileSync(BIN, [], { encoding: 'utf8', input: JSON.stringify(cases), maxBuffer: 64 * 1024 * 1024 })) as Out[]
    expect(rust).toHaveLength(cases.length)
    cases.forEach(({ text, max }, i) => {
      const want: Out = {
        iban: maskIban(text),
        numbers: maskNumbers(text),
        contacts: maskContacts(text),
        private: maskPrivate(text, max ?? undefined),
        cut: max === null ? null : cutText(text, max)
      }
      expect(rust[i], JSON.stringify({ text, max })).toEqual(want)
    })
  })

  it('hides the secrets and keeps the rest', () => {
    const out = maskPrivate(`Card ${CARD} Shop, mail ${MAIL}, call ${PHONE}, to ${SPACED} on 2026-10-01`)
    expect(out).toBe('Card …3456 Shop, mail …@… call …phone…, to NL…4300 on 2026-10-01')
  })
})
