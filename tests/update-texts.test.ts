import { describe, expect, it } from 'vitest'
import { LANGUAGE_CODES } from '@shared/languages'
import { BY_LANGUAGE, UPDATE_TEXT_KEYS, updateTexts } from '../src/main/update-texts'

describe('texts of the Windows update window', () => {
  it('has all six texts, filled in, for every language', () => {
    for (const code of LANGUAGE_CODES) {
      const texts = updateTexts(code)
      expect(Object.keys(texts).sort(), code).toEqual([...UPDATE_TEXT_KEYS].sort())
      for (const key of UPDATE_TEXT_KEYS) expect(texts[key].trim(), `${code} ${key}`).not.toBe('')
    }
  })

  it('uses the language of the person', () => {
    expect(updateTexts('nl').starting).toBe('Kasboek wordt gestart…')
    expect(updateTexts('de').waiting).toContain('Kasboek')
    expect(updateTexts('nl').starting).not.toBe(updateTexts('en').starting)
    expect(updateTexts('nl').notClosed).toContain('niet op tijd')
  })

  it('falls back to the base language, then to English', () => {
    expect(BY_LANGUAGE['es-419'].helper).toBeUndefined()
    expect(updateTexts('es-419')).toEqual(updateTexts('es'))
    expect(updateTexts('pt-BR').waiting).toBe('Aguardando o Kasboek fechar…')
    expect(updateTexts('xx')).toEqual(updateTexts('en'))
    expect(updateTexts('')).toEqual(updateTexts('en'))
  })

  it('leaves {{version}} for the helper, and only in the installing text', () => {
    for (const code of LANGUAGE_CODES) {
      const texts = updateTexts(code)
      expect(texts.installing, code).toContain('{{version}}')
      for (const key of UPDATE_TEXT_KEYS.filter((k) => k !== 'installing')) expect(texts[key], `${code} ${key}`).not.toContain('{{')
    }
  })
})
