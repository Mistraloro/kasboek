import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { setPasswordKdfForTests } from '@core/crypto'
import { openDatabase } from '@core/database'
import { DEFAULT_SETTINGS, getSettings, resetImportedSettings, updateSettings } from '@core/settings'
import { shownAccount, shownText } from '@shared/hide-numbers'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))

const openDb = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-hide-')), 'k.db'), randomBytes(32).toString('hex'))

describe('hiding account numbers on screen', () => {
  it('shows country and last four, also for a number that is not a valid IBAN or has spaces', () => {
    expect(shownAccount('BE68539007547034', true)).toBe('BE…7034')
    expect(shownAccount('BE68 5390 0754 7034', true)).toBe('BE…7034')
    expect(shownAccount('XX1234567890123', true)).toBe('XX…0123')
    expect(shownAccount('1234', true)).toBe('1234')
  })

  it('shows the whole number in groups of four when not hidden', () => {
    expect(shownAccount('BE68539007547034', false)).toBe('BE68 5390 0754 7034')
  })

  it('hides account and card numbers inside a text, and leaves the rest', () => {
    expect(shownText('Transfer to BE68539007547034 thanks', true)).toBe('Transfer to BE…7034 thanks')
    expect(shownText('card 4111 1111 1111 1111', true)).toBe('card …1111')
    expect(shownText('Delhaize 12-03-2026', true)).toBe('Delhaize 12-03-2026')
    expect(shownText('Transfer to BE68539007547034', false)).toBe('Transfer to BE68539007547034')
  })

  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.hideAccountNumbers).toBe(true)
    expect(getSettings(openDb()).hideAccountNumbers).toBe(true)
  })

  it('can be turned off by the person, but not by an imported file', () => {
    const d = openDb()
    updateSettings(d, { hideAccountNumbers: false })
    expect(getSettings(d).hideAccountNumbers).toBe(false)
    resetImportedSettings(d)
    expect(getSettings(d).hideAccountNumbers).toBe(true)
  })
})

/** Renderer lines that mention an account number field must show it through the helper components. */
describe('account numbers in the renderer', () => {
  const root = join(__dirname, '../src/renderer/src')
  const files: string[] = []
  const walk = (d: string): void => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx$/.test(f) && files.push(join(d, f))))
  walk(root)
  const mention = /\.iban\b|counterpartyIban|\.bankReference/
  const wrapped = /<Iban\b|<IbanInput\b|<Masked\b|shownAccount\(|shownText\(/
  // Places that handle the field without showing it: the form state that IbanInput edits, the names of
  // the columns to map, and the "statement is for another account" notes, which core already masks.
  const allowed: [string, RegExp][] = [
    ['pages/settings-sections/AccountsSection.tsx', /iban: /],
    ['pages/import-parts/MappingModal.tsx', /FIELDS/],
    ['pages/import-parts/PreviewView.tsx', /iban: n\.iban/]
  ]

  it('shows none of them without <Iban>, <IbanInput> or <Masked>', () => {
    const bad: string[] = []
    for (const f of files) {
      const rel = f.slice(root.length + 1)
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!mention.test(line) || wrapped.test(line)) return
        if (allowed.some(([file, re]) => rel === file && re.test(line))) return
        bad.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })
})
