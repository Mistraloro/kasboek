export type SetupStep = 'choose' | 'password' | 'import' | 'recovery' | 'twofactor'

/**
 * Whether the first-run screen may re-check Windows Hello when the window gets focus back.
 * Only before an account exists: afterwards the main process is already unlocked, so a refresh
 * would swap this screen for the app and skip the recovery key check.
 */
export function mayRefreshOnFocus(step: SetupStep): boolean {
  return step === 'choose'
}

/**
 * Whether the first-run screen is shown. Once the account is created the main process is already
 * unlocked, so the screen stays until the flow (recovery key, optional two-factor) has ended.
 */
export function showSetup(stateFromMain: 'setup' | 'locked' | 'unlocked', flowActive: boolean): boolean {
  return flowActive || stateFromMain === 'setup'
}

/** The last group of a recovery key, which the person types back to show they saved it. */
export function recoveryKeyTail(recoveryKey: string): string {
  return recoveryKey.split('-').at(-1) ?? ''
}

/** Continue on the recovery key screen: only when "saved" is ticked and the last group matches. */
export function recoveryKeyConfirmed(recoveryKey: string, saved: boolean, typed: string): boolean {
  const tail = recoveryKeyTail(recoveryKey)
  return saved && tail !== '' && typed === tail
}
