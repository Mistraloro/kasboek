import { describe, expect, it } from 'vitest'
import { helloScript } from '../src/main/security/device-auth'

describe('Windows Hello prompt', () => {
  it('passes Kasboek’s window to the prompt, with the plain call as fallback', () => {
    const s = helloScript('Unlock Kasboek', 1311000n)
    expect(s).toContain('[Int64]1311000')
    expect(s).toContain("$reason = 'Unlock Kasboek'")
    expect(s).toContain('[KasboekHello]::RequestForWindow($factory, $hwnd, $reason, $iid)')
    expect(s).toContain('RequestVerificationAsync($reason)')
    // The C# block is a double-quoted here-string: it must hold no PowerShell variables.
    const cs = s.slice(s.indexOf('@"'), s.indexOf('"@'))
    expect(cs).not.toMatch(/\$/)
  })
})
