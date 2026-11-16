import { describe, expect, it } from 'vitest'
import { answerIsFresh, describeRun, encodeCommand, helloScript, interpretHello, lastLine, markedResult, NEGATIVE_TTL_MS, psQuote, serialQueue } from '../src/main/security/device-auth'

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
    expect(s.trimEnd().endsWith('Write-Output "RESULT:$r"')).toBe(true)
  })
})

describe('encoded command', () => {
  it('is the prelude plus script as base64 of UTF-16LE', () => {
    const script = helloScript('Unlock Kasboek')
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le')
    expect(decoded.endsWith(script)).toBe(true)
    expect(decoded).toContain('Add-Type -AssemblyName System.Runtime.WindowsRuntime')
  })
  it('round-trips the real script with the sentinel, and silences progress output', () => {
    const script = helloScript(psQuote('Confirm it\u2019s you'))
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le')
    expect(decoded).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(decoded).toContain('Write-Output "RESULT:$r"')
    expect(decoded.endsWith(script)).toBe(true)
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

describe('Windows Hello answers', () => {
  const run = (out: string, extra = {}) => ({ out, err: '', code: 0, signal: null, ms: 1, timedOut: false, ...extra })
  it('reads only the marked value', () => {
    expect(markedResult('RESULT:Verified')).toBe('Verified')
    expect(markedResult('Verified')).toBeNull()
    expect(markedResult('')).toBeNull()
  })
  it('verifies, and treats a cancel or our own timeout as a plain false', () => {
    expect(interpretHello(run('RESULT:Verified'))).toBe(true)
    expect(interpretHello(run('RESULT:Canceled'))).toBe(false)
    expect(interpretHello(run('', { code: null, signal: 'SIGTERM', timedOut: true }))).toBe(false)
  })
  it('gives each other answer its own error', () => {
    const codes: Record<string, string> = {
      DeviceNotPresent: 'auth.device_not_present',
      NotConfiguredForUser: 'auth.device_not_configured',
      DisabledByPolicy: 'auth.device_disabled',
      DeviceBusy: 'auth.device_busy',
      RetriesExhausted: 'auth.device_retries_exhausted'
    }
    for (const [value, code] of Object.entries(codes)) {
      expect(() => interpretHello(run(`RESULT:${value}`))).toThrowError(expect.objectContaining({ code }))
    }
  })
  it('says Windows Hello could not be started when the marker is missing or the value is unknown', () => {
    expect(() => interpretHello(run('', { code: 0 }))).toThrowError(expect.objectContaining({ code: 'auth.device_unavailable' }))
    expect(() => interpretHello(run('Verified'))).toThrowError(expect.objectContaining({ code: 'auth.device_unavailable' }))
    expect(() => interpretHello(run('RESULT:Surprise'))).toThrowError(expect.objectContaining({ code: 'auth.device_unavailable' }))
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
  it('turns line breaks into spaces and keeps other text, since the script is sent encoded', () => {
    expect(psQuote('a\nb\r\u00e9')).toBe('a b \u00e9')
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
