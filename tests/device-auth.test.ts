import { describe, expect, it } from 'vitest'
import { answerIsFresh, helloScript, NEGATIVE_TTL_MS, psQuote } from '../src/main/security/device-auth'

describe('Windows Hello prompt', () => {
  it('asks with the plain call and brings the prompt forward', () => {
    const s = helloScript('Unlock Kasboek')
    expect(s).toContain("$reason = 'Unlock Kasboek'")
    expect(s).not.toContain('RequestVerificationForWindowAsync')
    expect(s).toContain('[KasboekHello]::BringPromptForward()')
    expect(s).toContain('RequestVerificationAsync($reason)')
    // The C# block is a double-quoted here-string: it must hold no PowerShell variables.
    const cs = s.slice(s.indexOf('@"'), s.indexOf('"@'))
    expect(cs).not.toMatch(/\$/)
  })

  it('still shows the prompt when the bring-to-front helper cannot be compiled', () => {
    const s = helloScript('x')
    const add = s.indexOf('Add-Type -TypeDefinition')
    expect(s.lastIndexOf('try {', add)).toBeGreaterThan(s.indexOf("$reason = 'x'"))
    expect(s.indexOf('} catch { $bringForward = $false }')).toBeGreaterThan(s.indexOf('"@\n}'))
    expect(s.indexOf('RequestVerificationAsync')).toBeGreaterThan(s.indexOf('$bringForward = $false'))
  })
})

describe('psQuote', () => {
  it('doubles plain quotes and turns typographic quotes into safe ones', () => {
    expect(psQuote("it's")).toBe("it''s")
    expect(psQuote('it\u2019s')).toBe("it''s")
    expect(psQuote('\u2018a\u201B')).toBe("''a''")
  })
  it('drops line breaks and non-ASCII so the string literal cannot end early', () => {
    expect(psQuote('a\nb\r\u00e9')).toBe('a b  ')
  })
})

describe('answer cache', () => {
  it('keeps a positive answer, lets a negative one expire, and has no answer before the first check', () => {
    expect(answerIsFresh(undefined, 0, 1)).toBe(false)
    expect(answerIsFresh('windows-hello', 0, 10 * NEGATIVE_TTL_MS)).toBe(true)
    expect(answerIsFresh(null, 0, NEGATIVE_TTL_MS - 1)).toBe(true)
    expect(answerIsFresh(null, 0, NEGATIVE_TTL_MS)).toBe(false)
  })
})
