/** Whether Windows Hello or Touch ID may stand in for the password on this computer. */
import { keyProtection } from './account-store'
import { deviceAuthKind } from './device-auth'

/** Passwordless mode keeps the key in the account file: only safe when the operating system seals that file. */
export async function keyIsOsProtected(): Promise<boolean> {
  return (await keyProtection()) === 'os'
}

/** Passwordless mode needs both a device check to unlock with and an operating-system-sealed key. */
export async function canUseDeviceMode(): Promise<boolean> {
  return !!(await deviceAuthKind()) && (await keyIsOsProtected())
}
