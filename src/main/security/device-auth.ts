/**
 * Passwordless verification with the operating system:
 *   Windows → Windows Hello (face, fingerprint or PIN), via the WinRT UserConsentVerifier
 *   macOS   → Touch ID
 * Linux has no common equivalent, so passwordless is not offered there.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, systemPreferences } from 'electron'
import { startupLog } from '../graphics'

export type DeviceAuthKind = 'windows-hello' | 'touch-id' | null

// Dev/test only: simulate a device check on machines without one. Ignored in packaged builds.
const fake = (): boolean => !app.isPackaged && process.env['KASBOEK_FAKE_DEVICE_AUTH'] === '1'

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
`

export interface PowerShellResult {
  /** The last non-empty line of stdout, trimmed, so stray output cannot hide the result. */
  out: string
  err: string
  code: number | null
  signal: NodeJS.Signals | null
  ms: number
  /** True when our own timeout killed the process. */
  timedOut: boolean
}

/** The last non-empty line of the text, trimmed. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  return lines[lines.length - 1] ?? ''
}

/** What -EncodedCommand expects: the whole script as base64 of UTF-16LE text. */
export function encodeCommand(script: string): string {
  return Buffer.from(PS_PRELUDE + script, 'utf16le').toString('base64')
}

function powershell(script: string, timeoutMs: number): Promise<PowerShellResult> {
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ out: '', err: e.message, code: null, signal: null, ms: Date.now() - started, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ out: lastLine(out), err: err.trim(), code, signal, ms: Date.now() - started, timedOut })
    })
  })
}

/** One startup.log line describing how a PowerShell run ended. Only fixed text and PowerShell's own output. */
export function describeRun(what: 'check' | 'prompt', r: PowerShellResult): string {
  const err = r.err.slice(0, 600).replace(/\r?\n/g, ' | ')
  return `windows hello: ${what} -> out='${r.out}' exit=${r.code ?? 'none'} signal=${r.signal ?? 'none'} ms=${r.ms}${r.timedOut ? ' timed out' : ''} err='${err}'`
}

/** Runs tasks one after another, so that two never overlap. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }
}

const oneAtATime = serialQueue()

let cached: DeviceAuthKind | undefined
let cachedAt = 0
let pending: Promise<DeviceAuthKind> | null = null

/** "Not available" is only remembered briefly: Hello may be set up, or just busy, while Kasboek is open. */
export const NEGATIVE_TTL_MS = 10_000

/** Whether an earlier answer can still be used. A positive answer stays; a negative one expires. */
export function answerIsFresh(answer: DeviceAuthKind | undefined, answeredAt: number, now: number): boolean {
  if (answer === undefined) return false
  if (answer !== null) return true
  return now - answeredAt < NEGATIVE_TTL_MS
}

function remember(kind: DeviceAuthKind): DeviceAuthKind {
  cached = kind
  cachedAt = Date.now()
  return kind
}

/** The answer if the check has finished, otherwise undefined (and the check is started). */
export function peekDeviceAuthKind(onDone?: () => void): DeviceAuthKind | undefined {
  if (!answerIsFresh(cached, cachedAt, Date.now()) && !pending) {
    pending = deviceAuthKind().finally(() => {
      pending = null
      onDone?.()
    })
  }
  return cached
}

export async function deviceAuthKind(): Promise<DeviceAuthKind> {
  if (answerIsFresh(cached, cachedAt, Date.now())) return cached ?? null
  if (fake()) return remember(process.platform === 'darwin' ? 'touch-id' : 'windows-hello')
  if (process.platform === 'darwin') return remember(systemPreferences.canPromptTouchID() ? 'touch-id' : null)
  if (process.platform === 'win32') {
    const r = await powershell(
      `$a = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); Write-Output $a`,
      15_000
    )
    startupLog(describeRun('check', r))
    return remember(r.out === 'Available' ? 'windows-hello' : null)
  }
  return remember(null)
}

/** Shows the system prompt. Resolves true only if the user was verified. */
export async function verifyDeviceUser(reason: string): Promise<boolean> {
  if (fake()) return process.env['KASBOEK_FAKE_DEVICE_RESULT'] !== 'deny'
  const kind = await deviceAuthKind()
  if (kind === 'touch-id') {
    try {
      await systemPreferences.promptTouchID(reason)
      return true
    } catch {
      return false
    }
  }
  if (kind === 'windows-hello') {
    return oneAtATime(async () => {
      startupLog('windows hello: asking')
      const r = await powershell(helloScript(psQuote(reason)), 120_000)
      startupLog(describeRun('prompt', r))
      if (r.out === '' && (r.code !== 0 || r.signal !== null)) {
        startupLog(`windows hello: prompt ended without an answer (exit=${r.code ?? 'none'} signal=${r.signal ?? 'none'})`)
      }
      return r.out === 'Verified'
    })
  }
  return false
}

/**
 * Text for inside a single-quoted PowerShell string. PowerShell also treats the typographic quotes
 * (U+2018 to U+201B) as quotes, so a reason such as "Confirm it's you" typed with one would end the
 * string early and the script would not parse. Anything else outside plain ASCII is dropped, to keep
 * the prompt text plain.
 */
export function psQuote(text: string): string {
  return text
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/'/g, "''")
}

/**
 * Windows Hello. The prompt comes from a PowerShell process without a window, so Windows may open it
 * behind Kasboek; a background thread brings the prompt window ("Credential Dialog Xaml Host") to
 * the front once it appears. (0.13.0 passed Kasboek's window to RequestVerificationForWindowAsync
 * instead, but that window belongs to another process, and the check then failed.)
 */
export function helloScript(reason: string): string {
  return `
[Console]::Error.WriteLine('step: start')
$reason = '${reason}'
$bringForward = $true
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class KasboekHello {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void BringPromptForward() {
    Thread t = new Thread(delegate () {
      for (int i = 0; i < 100; i++) {
        IntPtr h = FindWindow("Credential Dialog Xaml Host", null);
        if (h != IntPtr.Zero) {
          // A tap of Alt lets this process move another window to the front.
          keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
          SetForegroundWindow(h);
          BringWindowToTop(h);
          return;
        }
        Thread.Sleep(100);
      }
    });
    t.IsBackground = true;
    t.Start();
  }
}
"@
[Console]::Error.WriteLine('step: helper compiled')
} catch { $bringForward = $false; [Console]::Error.WriteLine('step: helper skipped: ' + $_.Exception.Message) }
# Bringing the prompt forward is only a convenience: if the helper cannot be compiled (security
# software, a restricted language mode, an unwritable temp folder), still show the prompt.
if ($bringForward) { try { [KasboekHello]::BringPromptForward() } catch { } }
[Console]::Error.WriteLine('step: prompting')
$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($reason)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
[Console]::Error.WriteLine('step: result: ' + $r)
Write-Output $r
`
}
