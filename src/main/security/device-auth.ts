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

function powershell(script: string, timeoutMs: number): Promise<{ out: string; err: string }> {
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => resolve({ out: '', err: e.message }))
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ out: out.trim(), err: err.trim() })
    })
    child.stdin.end(PS_PRELUDE + script)
  })
}

let cached: DeviceAuthKind | undefined
let pending: Promise<DeviceAuthKind> | null = null

/** The answer if the check has finished, otherwise undefined (and the check is started). */
export function peekDeviceAuthKind(onDone?: () => void): DeviceAuthKind | undefined {
  if (cached === undefined && !pending) {
    pending = deviceAuthKind().finally(() => {
      pending = null
      onDone?.()
    })
  }
  return cached
}

export async function deviceAuthKind(): Promise<DeviceAuthKind> {
  if (cached !== undefined) return cached
  if (fake()) return (cached = process.platform === 'darwin' ? 'touch-id' : 'windows-hello')
  if (process.platform === 'darwin') return (cached = systemPreferences.canPromptTouchID() ? 'touch-id' : null)
  if (process.platform === 'win32') {
    const r = await powershell(
      `$a = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); Write-Output $a`,
      15_000
    )
    startupLog(`windows hello: ${r.out || 'no answer'}${r.err ? ` (${r.err.slice(0, 300)})` : ''}`)
    return (cached = r.out === 'Available' ? 'windows-hello' : null)
  }
  return (cached = null)
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
    const safe = reason.replace(/'/g, "''")
    const r = await powershell(helloScript(safe), 120_000)
    startupLog(`windows hello: ${r.out || 'no answer'}${r.err ? ` (${r.err.slice(0, 300)})` : ''}`)
    return r.out === 'Verified'
  }
  return false
}

/**
 * Windows Hello. The prompt comes from a PowerShell process without a window, so Windows may open it
 * behind Kasboek; a background thread brings the prompt window ("Credential Dialog Xaml Host") to
 * the front once it appears. (0.13.0 passed Kasboek's window to RequestVerificationForWindowAsync
 * instead, but that window belongs to another process, and the check then failed.)
 */
export function helloScript(reason: string): string {
  return `
$reason = '${reason}'
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
try { [KasboekHello]::BringPromptForward() } catch { }
$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($reason)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output $r
`
}
