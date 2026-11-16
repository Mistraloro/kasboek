/**
 * Passwordless verification with the operating system:
 *   Windows → Windows Hello (face, fingerprint or PIN), via the WinRT UserConsentVerifier
 *   macOS   → Touch ID
 * Linux has no common equivalent, so passwordless is not offered there.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, systemPreferences } from 'electron'

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
    const r = await powershell(helloScript(safe, kasboekWindowHandle()), 120_000)
    return r === 'Verified'
  }
  return false
}

/** Kasboek's window as a Win32 handle, so Windows Hello opens in front of it. 0 when there is none. */
function kasboekWindowHandle(): bigint {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => w.isVisible()) ?? null
  if (!win) return 0n
  const buf = win.getNativeWindowHandle()
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
}

/**
 * Windows Hello for a window. Started from PowerShell, the plain RequestVerificationAsync has no
 * window of its own, so Windows opens the prompt behind Kasboek. The interop variant
 * (IUserConsentVerifierInterop::RequestVerificationForWindowAsync) takes Kasboek's window as the
 * owner and opens in front of it. If that isn't available, the plain call is used, and the prompt
 * window ("Credential Dialog Xaml Host") is brought to the front once it appears.
 */
export function helloScript(reason: string, hwnd: bigint): string {
  return `
$reason = '${reason}'
$hwnd = [IntPtr]::new([Int64]${hwnd.toString()})
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class KasboekHello {
  [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  public interface IUserConsentVerifierInterop {
    [return: MarshalAs(UnmanagedType.IInspectable)]
    object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
  }
  // The cast asks the activation factory for the interop interface (QueryInterface), which a
  // PowerShell cast doesn't do reliably.
  public static object RequestForWindow(object factory, IntPtr hwnd, string message, Guid iid) {
    return ((IUserConsentVerifierInterop)factory).RequestVerificationForWindowAsync(hwnd, message, ref iid);
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Brings the Windows Hello prompt to the front once it appears (a fallback; up to 5 seconds).
  public static void BringPromptForward() {
    new Thread(() => {
      for (int i = 0; i < 50; i++) {
        IntPtr h = FindWindow("Credential Dialog Xaml Host", null);
        if (h != IntPtr.Zero) {
          // A tap of Alt lets this process move another window to the front.
          keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
          SetForegroundWindow(h);
          return;
        }
        Thread.Sleep(100);
      }
    }) { IsBackground = true }.Start();
  }
}
"@
$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
$op = $null
if ($hwnd -ne [IntPtr]::Zero) {
  try {
    $factory = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory([Windows.Security.Credentials.UI.UserConsentVerifier])
    $iid = [Windows.Foundation.IAsyncOperation[Windows.Security.Credentials.UI.UserConsentVerificationResult]].GUID
    $op = [KasboekHello]::RequestForWindow($factory, $hwnd, $reason, $iid)
  } catch { $op = $null }
}
if ($op -eq $null) {
  [KasboekHello]::BringPromptForward()
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($reason)
}
$r = Await $op $resultType
Write-Output $r
`
}
