import { describe, expect, it } from 'vitest'
import { answerIsFresh, describeRun, encodeCommand, helloScript, lastLine, NEGATIVE_TTL_MS, psQuote, serialQueue } from '../src/main/security/device-auth'

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
    expect(s.indexOf('} catch { $bringForward = $false;')).toBeGreaterThan(s.indexOf('"@\n'))
    expect(s.indexOf('RequestVerificationAsync')).toBeGreaterThan(s.indexOf('$bringForward = $false'))
  })
})

describe('Windows Hello step markers', () => {
  it('writes progress to stderr and keeps stdout for the result', () => {
    const s = helloScript('x')
    for (const m of ["'step: start'", "'step: helper compiled'", "'step: helper skipped: ' + $_.Exception.Message", "'step: prompting'", "'step: result: ' + $r"]) {
      expect(s).toContain(`[Console]::Error.WriteLine(${m})`)
    }
    expect(s.indexOf("'step: prompting'")).toBeLessThan(s.indexOf('RequestVerificationAsync($reason)'))
    expect(s.indexOf("'step: result: '")).toBeGreaterThan(s.indexOf('RequestVerificationAsync($reason)'))
    expect(s.match(/Write-Output/g)).toHaveLength(1)
  })
})

describe('encoded command', () => {
  it('is the prelude plus script as base64 of UTF-16LE', () => {
    const script = helloScript('Unlock Kasboek')
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le')
    expect(decoded.endsWith(script)).toBe(true)
    expect(decoded).toContain('Add-Type -AssemblyName System.Runtime.WindowsRuntime')
  })
  it('keeps non-ASCII text intact', () => {
    const decoded = Buffer.from(encodeCommand("Write-Output 'caf\u00e9 \u{1F600}'"), 'base64').toString('utf16le')
    expect(decoded.endsWith("Write-Output 'caf\u00e9 \u{1F600}'")).toBe(true)
  })
  it('stays well below the Windows command-line limit of about 32,000 characters', () => {
    const longest = helloScript(psQuote('x'.repeat(500)))
    const line = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodeCommand(longest)}`
    expect(line.length).toBeLessThan(16_000)
  })
})

describe('result parsing', () => {
  it('takes the last non-empty line, trimmed', () => {
    expect(lastLine('Verified\r\n')).toBe('Verified')
    expect(lastLine('noise\r\n  Verified  \r\n\r\n')).toBe('Verified')
    expect(lastLine('')).toBe('')
    expect(lastLine(' \n ')).toBe('')
  })
})

describe('log line', () => {
  const base = { out: '', err: '', code: 0, signal: null, ms: 12, timedOut: false }
  it('shows output, exit code, signal, time and the start of stderr on one line', () => {
    expect(describeRun('prompt', { ...base, out: 'Verified', err: 'step: start\r\nstep: prompting' })).toBe(
      "windows hello: prompt -> out='Verified' exit=0 signal=none ms=12 err='step: start | step: prompting'"
    )
  })
  it('marks a timeout and a signal, and caps stderr at 600 characters', () => {
    const l = describeRun('check', { ...base, code: null, signal: 'SIGTERM', timedOut: true, err: 'e'.repeat(900) })
    expect(l).toBe(`windows hello: check -> out='' exit=none signal=SIGTERM ms=12 timed out err='${'e'.repeat(600)}'`)
  })
})

describe('one prompt at a time', () => {
  it('starts a second task only after the first has finished, even if the first fails', async () => {
    const queue = serialQueue()
    const events: string[] = []
    let release!: () => void
    const first = queue(
      () =>
        new Promise<boolean>((_, reject) => {
          events.push('first start')
          release = () => {
            events.push('first end')
            reject(new Error('boom'))
          }
        })
    )
    const second = queue(async () => {
      events.push('second start')
      return true
    })
    await Promise.resolve()
    expect(events).toEqual(['first start'])
    release()
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe(true)
    expect(events).toEqual(['first start', 'first end', 'second start'])
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
