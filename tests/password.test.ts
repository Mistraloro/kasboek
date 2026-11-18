import { describe, expect, it } from 'vitest'
import { checkPassword } from '@shared/password'

describe('password rules', () => {
  it('accepts long passphrases and long mixed passwords', () => {
    expect(checkPassword('kraan-tulp-Ober-7-fiets-mist').ok).toBe(true)
    expect(checkPassword('Vh9#qL2!mZp4wT8x').ok).toBe(true)
  })
  it('refuses short, uniform, common, patterned or app-named passwords', () => {
    expect(checkPassword('Short1!').issues).toContain('length')
    expect(checkPassword('alllowercaseletterslong').issues).toContain('variety')
    expect(checkPassword('Welkom2026!Welkom2026!').ok).toBe(false)
    expect(checkPassword('P@ssw0rd12345678!').issues).toContain('common')
    expect(checkPassword('MijnKasboek2026!!x').issues).toContain('appName')
    expect(checkPassword('Aaaa1111bbbb!!!!xyz').issues).toContain('pattern')
    expect(checkPassword('Qwerty!234567890Ab').issues).toContain('pattern')
  })
  it('enforces the 12-character minimum at the boundary', () => {
    expect(checkPassword('Vh9#qL2!mZp').issues).toContain('length') // 11
    expect(checkPassword('Vh9#qL2!mZp4')).toMatchObject({ ok: true, issues: [] }) // 12
    expect(checkPassword('Vh9#qL2mZp4k').ok).toBe(true) // 12, letters and digits only in three classes
    expect(checkPassword('qhvjzpmwnbkd').issues).toContain('variety') // 12 lowercase only
  })
  it('rates strength from very weak to strong', () => {
    expect(checkPassword('').strength).toBe(0)
    expect(checkPassword('abc').strength).toBeLessThan(2)
    expect(checkPassword('kraan-tulp-Ober-7-fiets-mist').strength).toBe(4)
  })
})
