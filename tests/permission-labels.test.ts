import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_MODES } from '@shared/permissions'

type Permissions = { modes: Record<string, string>; modeHint: Record<string, string>; trustNote: string }
const full = ['en', 'nl', 'de', 'fr', 'es', 'pt-PT']
const read = (lang: string): Permissions => (JSON.parse(readFileSync(`src/renderer/src/i18n/locales/${lang}.json`, 'utf8')) as { permissions: Permissions }).permissions

describe('permission mode texts', () => {
  it('uses the short English names', () => {
    expect(PERMISSION_MODES.map((m) => read('en').modes[m])).toEqual(['Ask first', 'Smart', 'Full access', 'Custom'])
  })

  it.each(full)('%s has a label and a hint for every mode, and the note about what always asks', (lang) => {
    const p = read(lang)
    for (const m of PERMISSION_MODES) {
      expect(p.modes[m], `${lang} modes.${m}`).toBeTruthy()
      expect(p.modeHint[m], `${lang} modeHint.${m}`).toBeTruthy()
    }
    expect(p.trustNote, `${lang} trustNote`).toBeTruthy()
    expect(p.modeHint.smart).toContain('{{limit}}')
    expect(p.modeHint.custom).toContain('{{limit}}')
  })
})
