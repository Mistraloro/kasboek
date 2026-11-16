/**
 * Passwordless verification with the operating system:
 *   Windows → Windows Hello (face, fingerprint or PIN), via the WinRT UserConsentVerifier
 *   macOS   → Touch ID
 * Linux has no common equivalent, so passwordless is not offered there.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, systemPreferences } from 'electron'
import { AppError } from '@core/errors'
import { startupLog } from '../graphics'

export type DeviceAuthKind = 'windows-hello' | 'touch-id' | null

// Dev/test only: simulate a device check on machines without one. Ignored in packaged builds.
const fake = (): boolean => !app.isPackaged && process.env['KASBOEK_FAKE_DEVICE_AUTH'] === '1'

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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

/** How long after kill() we wait for the process to close before giving up on its pipes. */
export const KILL_GRACE_MS = 2_000

/**
 * Runs a process and always settles. After our timeout kills it, a grandchild that inherited the
 * pipes (the compiler started by Add-Type) can keep them open, so `close` never fires: after a short
 * grace period the streams are destroyed and the run ends as timed out. A late `close` or `error` is ignored.
 */
export function runProcess(spawnFn: typeof spawn, exe: string, args: string[], timeoutMs: number, killGraceMs = KILL_GRACE_MS): Promise<PowerShellResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawnFn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const finish = (code: number | null, signal: NodeJS.Signals | null, errorText?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ out: errorText === undefined ? lastLine(out) : '', err: errorText ?? err.trim(), code, signal, ms: Date.now() - started, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      killTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null, null)
      }, killGraceMs)
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (err += String(d)))
    child.on('error', (e) => finish(null, null, e.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function powershell(script: string, timeoutMs: number): Promise<PowerShellResult> {
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return runProcess(spawn, exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)], timeoutMs)
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

/** Marks the result on stdout; a run that ends without it did not get as far as asking. */
export const RESULT_MARKER = 'RESULT:'

/** The value after the marker in a run's last stdout line, or null when the marker is missing. */
export function markedResult(out: string): string | null {
  return out.startsWith(RESULT_MARKER) ? out.slice(RESULT_MARKER.length).trim() : null
}

const HELLO_ERRORS: Record<string, [code: string, message: string]> = {
  DeviceNotPresent: ['auth.device_not_present', 'Windows Hello is not set up on this computer: no camera, fingerprint reader or PIN is available.'],
  NotConfiguredForUser: ['auth.device_not_configured', 'Windows Hello is not set up for your Windows account. Set it up in Windows settings first.'],
  DisabledByPolicy: ['auth.device_disabled', 'Windows Hello is turned off by a policy on this computer.'],
  DeviceBusy: ['auth.device_busy', 'Windows Hello is busy. Try again in a moment.'],
  RetriesExhausted: ['auth.device_retries_exhausted', 'Windows Hello stopped after too many failed attempts. Try again later.']
}

/** True when verified, false for a cancel (or our own timeout); throws a specific error for everything else. */
export function interpretHello(r: PowerShellResult): boolean {
  const value = markedResult(r.out)
  if (value === 'Verified') return true
  if (value === 'Canceled' || r.timedOut) return false
  const known = value === null ? undefined : HELLO_ERRORS[value]
  if (known) throw new AppError(known[0], known[1])
  throw new AppError('auth.device_unavailable', 'Windows Hello could not be started.')
}

let cached: DeviceAuthKind | undefined
// The outcome of the last availability check that was logged: repeats are not logged again.
let lastLoggedCheck: string | undefined
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
      `$a = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); Write-Output "RESULT:$a"`,
      15_000
    )
    if (r.out !== lastLoggedCheck) {
      lastLoggedCheck = r.out
      startupLog(describeRun('check', r))
    }
    return remember(markedResult(r.out) === 'Available' ? 'windows-hello' : null)
  }
  return remember(null)
}

/** Shows the system prompt. Resolves true only if verified, false on a cancel; throws an AppError when Windows Hello cannot answer. */
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
      return interpretHello(r)
    })
  }
  return false
}

/**
 * Text for inside a single-quoted PowerShell string. PowerShell also treats the typographic quotes
 * (U+2018 to U+201B) as quotes, so a reason such as "Confirm it's you" typed with one would end the
 * string early and the script would not parse. Control characters (line breaks) become spaces; other
 * non-ASCII text is safe because the script travels base64-encoded.
 */
export function psQuote(text: string): string {
  return text
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\x00-\x1F\x7F]/g, ' ')
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
Write-Output "RESULT:$r"
`
}
