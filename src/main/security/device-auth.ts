/**
 * Passwordless verification with the operating system:
 *   Windows → Windows Hello (face, fingerprint or PIN), via the WinRT UserConsentVerifier
 *   macOS   → Touch ID
 * Linux has no common equivalent, so passwordless is not offered there.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, systemPreferences } from 'electron'

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

function powershell(script: string, timeoutMs: number): Promise<string> {
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', () => resolve(''))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim())
    })
    child.stdin.end(PS_PRELUDE + script)
  })
}

let cached: DeviceAuthKind | undefined

export async function deviceAuthKind(): Promise<DeviceAuthKind> {
  if (cached !== undefined) return cached
  if (fake()) return (cached = process.platform === 'darwin' ? 'touch-id' : 'windows-hello')
  if (process.platform === 'darwin') return (cached = systemPreferences.canPromptTouchID() ? 'touch-id' : null)
  if (process.platform === 'win32') {
    const r = await powershell(
      `$a = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); Write-Output $a`,
      15_000
    )
    return (cached = r === 'Available' ? 'windows-hello' : null)
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
    const r = await powershell(
      `$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${safe}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]); Write-Output $r`,
      120_000
    )
    return r === 'Verified'
  }
  return false
}
