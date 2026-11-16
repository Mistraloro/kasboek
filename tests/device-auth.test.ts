import { describe, expect, it } from 'vitest'
import { helloScript } from '../src/main/security/device-auth'

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
})
