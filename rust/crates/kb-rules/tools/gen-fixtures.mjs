// Writes tests/fixtures/rules.json: the answers of the TypeScript rules (src/shared/password.ts, iban.ts) for the inputs
// below, from the release TypeScript. Run: KB_TS_ROOT=/path/to/release/checkout node --experimental-strip-types
// rust/crates/kb-rules/tools/gen-fixtures.mjs (Node 22.6+). All data is invented.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.KB_TS_ROOT
if (!root) throw new Error('set KB_TS_ROOT to the release checkout whose src/shared is the reference')
const { checkPassword } = await import(pathToFileURL(join(root, 'src/shared/password.ts')).href)
const { findIbans, maskIban, maskNumbers, validIban } = await import(pathToFileURL(join(root, 'src/shared/iban.ts')).href)

const passwords = [
  '', 'a', 'password', 'Password1!', 'P@ssw0rd123', 'Welkom2026!', 'summersummer', 'correct horse battery 12',
  'kraan-tulp-Ober-7-fiets-mist', 'aaaaBBBB1111!!!!', 'abcdEFGH5678$%', 'qwertyuiop12AB', 'Xk9#mP2$vL7@nQ4!', '123123123123Ab',
  'ababababab12CD', 'Kasboek-is-leuk-2026', 'k@sb0ek-Zebra-77', 'Zebra-Maan-Tafel-91', 'ééééé-Ünï-çödé-12', 'only lowercase words here',
  'ONLYUPPERCASEWORDS', 'tulp\nkraan\nober 12AB', 'emoji-😀😀😀-Abc-123', 'zyxw-Vuts-Rqpo-1', 'Bank2026budget!', 'Leuven-Gent-1999', 'a1B2c3D4e5F6g7H8',
  'lenteLENTE12!!', 'Mm3$Nn4%Oo5^Pp6&', 'wxcvbn-Abc-1234-zz', 'Tr0ub4dor&3', 'correct-horse-battery-staple'
]
const ibanTexts = [
  '', 'no account here', 'BE68 5390 0754 7034', 'BE68539007547034', 'NL91 ABNA 0417 1643 00', 'NL91ABNA0417164300',
  'REFNL91ABNA0417164300 thanks', 'transfer to DE89 3704 0044 0532 0130 00 and GB82 WEST 1234 5698 7654 32 today',
  'lowercase nl91abna0417164300 too', 'FR14 2004 1010 0505 0001 3M02 606 end', 'XX00 1234 5678 9012 3456', 'ES9121000418450200051332 ES9121000418450200051332',
  'AAAA1234567890123456', 'ref 2026-11-15 2026-11-16 2026-11-17 2026-11-18', 'card 4111 1111 1111 1111 paid', 'long 1234567890123 number',
  '15-11-2026 16-11-2026 17-11-2026 18-11-2026', '2026-11-15 15-11-2026 2026-11-16 15-11-2026', 'BE71 0961 2345 6769 en BE68 5390 0754 7034',
  'prefixBE68539007547034suffix', 'tab\tBE68 5390 0754 7034', 'BE68 5390 0754 7034BE68 5390 0754 7034', 'NO93 8601 1117 947', 'IT60 X054 2811 1010 0000 0123 456',
  '12 digits 123456789012 only', '13 digits 1234567890123', '1234-5678-9012-3456 and 1234 5678 9012 3', 'café €12,50 BE68 5390 0754 7034 ünï'
]
const out = {
  passwords: passwords.map((p) => ({ input: p, ...checkPassword(p) })),
  iban: ibanTexts.map((t) => ({ input: t, mask: maskIban(t), found: findIbans(t), numbers: maskNumbers(t) })),
  valid: ['BE68539007547034', 'NL91ABNA0417164300', 'DE89370400440532013000', 'BE68539007547035', 'GB82WEST12345698765432', 'XX', ''].map((i) => ({ input: i, valid: validIban(i) }))
}
writeFileSync(new URL('../tests/fixtures/rules.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log('passwords', out.passwords.length, 'iban', out.iban.length)
