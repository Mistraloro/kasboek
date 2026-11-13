/**
 * Password rules and a strength estimate, shared by the setup screens (live meter) and by the main
 * process (which refuses anything that doesn't pass).
 *
 * Rules: at least 16 characters; at least three of lowercase, uppercase, digits, symbols; not a
 * common password or built from one; doesn't contain "kasboek"; no runs like "aaaa" or "1234".
 * Length counts most: a phrase of several random words passes easily and is easy to remember.
 */

export const MIN_PASSWORD_LENGTH = 16

export type PasswordIssue = 'length' | 'variety' | 'common' | 'appName' | 'pattern'
export type Strength = 0 | 1 | 2 | 3 | 4 // very weak … strong

export interface PasswordCheck {
  ok: boolean
  issues: PasswordIssue[]
  strength: Strength
  /** Rough guessing difficulty in bits, after penalties. */
  bits: number
  classes: number
}

// Most-used passwords and their building blocks (English, Dutch, French, German). Checked after
// undoing common substitutions (p@ssw0rd → password) and removing digits/symbols.
const COMMON = new Set(
  (
    'password passwort wachtwoord motdepasse paswoord welkom welcome bienvenue azerty qwerty qwertz azertyuiop qwertyuiop ' +
    'letmein iloveyou admin administrator root monkey dragon football voetbal soccer baseball master shadow sunshine ' +
    'princess superman batman trustno1 starwars whatever freedom secret geheim bonjour soleil chocolat amour liebe ' +
    'hallo hello login changeme default test testing abc abcdef abcdefgh asdfgh zxcvbn ' +
    'belgie belgique belgium brussel bruxelles antwerpen gent liege leuven bank budget money geld argent euro ' +
    'summer winter autumn spring zomer lente herfst'
  ).split(' ')
)

const LEET: Record<string, string> = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't' }

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azertyuiop', 'qsdfghjklm', 'wxcvbn', '1234567890']

function classesOf(pw: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
}

function hasPattern(pw: string): boolean {
  const s = pw.toLowerCase()
  if (/(.)\1{3,}/.test(s)) return true // aaaa
  if (/(.{2,4})\1{2,}/.test(s)) return true // ababab, 123123123
  for (let i = 0; i + 4 <= s.length; i++) {
    const c = [...s.slice(i, i + 4)].map((ch) => ch.charCodeAt(0))
    const up = c.every((v, j) => j === 0 || v === c[j - 1]! + 1)
    const down = c.every((v, j) => j === 0 || v === c[j - 1]! - 1)
    if (up || down) return true // abcd, 4321
  }
  return KEYBOARD_ROWS.some((row) => {
    for (let i = 0; i + 4 <= row.length; i++) if (s.includes(row.slice(i, i + 4))) return true
    return false
  })
}

function isCommon(pw: string): boolean {
  const lower = pw.toLowerCase()
  if (COMMON.has(lower)) return true
  const unleet = [...lower].map((ch) => LEET[ch] ?? ch).join('')
  // Check the letters both as typed and with substitutions undone (the 0 in "2026" is not an "o").
  for (const core of new Set([lower.replace(/[^a-z]/g, ''), unleet.replace(/[^a-z]/g, '')])) {
    // "Welkom2026!" or "P@ssw0rd123": a common word dressed up with digits and symbols.
    if (core.length >= 3 && COMMON.has(core)) return true
    for (const w of COMMON) {
      if (w.length < 4 || !core.includes(w)) continue
      // The same word repeated ("summersummer"), or a common word that is most of the letters.
      if (core.replace(new RegExp(w, 'g'), '') === '' || w.length * 2 >= core.length) return true
    }
  }
  return false
}

export function checkPassword(pw: string): PasswordCheck {
  const issues: PasswordIssue[] = []
  const classes = classesOf(pw)
  if ([...pw].length < MIN_PASSWORD_LENGTH) issues.push('length')
  if (classes < 3) issues.push('variety')
  if (pw && isCommon(pw)) issues.push('common')
  if (/kasboek|k@sb0ek|kasb0ek/i.test(pw)) issues.push('appName')
  if (pw && hasPattern(pw)) issues.push('pattern')

  // Bits ≈ length × log2(alphabet), with penalties for patterns and common words.
  const pool = (/[a-z]/.test(pw) ? 26 : 0) + (/[A-Z]/.test(pw) ? 26 : 0) + (/\d/.test(pw) ? 10 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 33 : 0)
  const unique = new Set(pw).size
  let bits = pool ? Math.min([...pw].length, unique * 2) * Math.log2(pool) : 0
  if (issues.includes('pattern')) bits *= 0.6
  if (issues.includes('common') || issues.includes('appName')) bits *= 0.3
  bits = Math.round(bits)

  const strength: Strength = bits >= 90 ? 4 : bits >= 70 ? 3 : bits >= 50 ? 2 : bits >= 30 ? 1 : 0
  return { ok: issues.length === 0 && strength === 4, issues, strength, bits, classes }
}
