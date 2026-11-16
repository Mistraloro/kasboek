/** Whether Kasboek draws its windows with the graphics card. Decided once, before the app starts. */

/** The person's choice in Settings → General. */
export const GRAPHICS_CHOICES = ['auto', 'on', 'off'] as const
export type GraphicsChoice = (typeof GRAPHICS_CHOICES)[number]

/**
 * Why Kasboek draws without the graphics card, or null when it uses it.
 * - `setting`: chosen in Settings.
 * - `windows-arm`: the automatic choice on Windows on ARM, where graphics drivers (Snapdragon) can
 *   leave Chromium-based windows white.
 * - `failed`: the graphics card failed to show Kasboek on an earlier start.
 * - `flag`: Kasboek was started with --disable-gpu.
 */
export type GraphicsReason = 'setting' | 'windows-arm' | 'failed' | 'flag'

export interface GraphicsStatus {
  hardware: boolean
  reason: GraphicsReason | null
}

export function decideGraphics(input: {
  choice: GraphicsChoice
  /** Set by Kasboek when the graphics card failed on an earlier start (only used for "auto"). */
  failedBefore: boolean
  platform: string
  arch: string
  disableGpuFlag: boolean
}): GraphicsStatus {
  const off = (reason: GraphicsReason): GraphicsStatus => ({ hardware: false, reason })
  if (input.disableGpuFlag) return off('flag')
  if (input.choice === 'off') return off('setting')
  if (input.choice === 'on') return { hardware: true, reason: null }
  if (input.failedBefore) return off('failed')
  if (input.platform === 'win32' && input.arch === 'arm64') return off('windows-arm')
  return { hardware: true, reason: null }
}

/** How the GPU process ended, from Electron's child-process-gone event: counts as a failure? */
export function isGpuFailure(reason: string): boolean {
  return reason === 'crashed' || reason === 'abnormal-exit' || reason === 'launch-failed' || reason === 'integrity-failure' || reason === 'oom'
}
