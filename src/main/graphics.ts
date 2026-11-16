/**
 * Drawing with or without the graphics card, and a small start-up log.
 *
 * Some graphics drivers (notably on Windows on ARM / Snapdragon) leave Chromium-based windows white.
 * Kasboek then draws in software: by default on Windows on ARM, by choice in Settings, or by itself
 * after the graphics card failed to show the window. The log (startup.log in the data folder) holds
 * only technical facts (version, system, graphics, start-up steps), never your data.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { decideGraphics, isGpuFailure, type GraphicsChoice, type GraphicsStatus } from '@shared/graphics'
import { paths } from './paths'
import { getPrefs, updatePrefs } from './prefs'

/** The main window must report its first screen within this time, or the graphics card gets the blame. */
const PAINT_TIMEOUT_MS = 15_000
const MAX_LOG_LINES = 200

let status: GraphicsStatus = { hardware: true, reason: null }
let lines = 0
let painted = false
let fallingBack = false
let gpuFailures = 0

const logFile = (): string => join(paths.dataDir, 'startup.log')

/** One line in startup.log, with the time since start. */
export function startupLog(text: string): void {
  if (lines >= MAX_LOG_LINES) return
  lines++
  try {
    appendFileSync(logFile(), `${(process.uptime() * 1000).toFixed(0).padStart(6)} ms  ${text}\n`)
  } catch {
    // The log is a convenience; never let it stop the app.
  }
}

/** Read the choice straight from prefs.json: this runs before the app is ready. */
function storedChoice(): { choice: GraphicsChoice; failedBefore: boolean } {
  try {
    if (existsSync(paths.prefsFile)) {
      const raw = JSON.parse(readFileSync(paths.prefsFile, 'utf8')) as { graphics?: unknown; graphicsFailed?: unknown }
      const choice = raw.graphics === 'on' || raw.graphics === 'off' ? raw.graphics : 'auto'
      return { choice, failedBefore: raw.graphicsFailed === true }
    }
  } catch {
    // Unreadable prefs: the automatic choice.
  }
  return { choice: 'auto', failedBefore: false }
}

/** Call at the top of the main process, before the app is ready. */
export function applyGraphicsChoice(): void {
  const stored = storedChoice()
  status = decideGraphics({ ...stored, platform: process.platform, arch: process.arch, disableGpuFlag: app.commandLine.hasSwitch('disable-gpu') })
  if (!status.hardware) app.disableHardwareAcceleration()
  try {
    mkdirSync(paths.dataDir, { recursive: true })
    writeFileSync(logFile(), '')
  } catch {
    // The log is a convenience.
  }
  startupLog(`Kasboek ${app.getVersion()} on ${process.platform} ${process.arch} (${release()}), Electron ${process.versions.electron}`)
  startupLog(`graphics: choice ${stored.choice}${stored.failedBefore ? ', failed before' : ''} -> ${status.hardware ? 'graphics card' : `software (${status.reason})`}`)
}

export function graphicsStatus(): GraphicsStatus {
  return status
}

/** Start again without the graphics card, once. */
function fallBack(why: string): void {
  if (fallingBack || !status.hardware) return
  // A development run (slow dev server, test machines without a GPU) only logs it.
  if (!app.isPackaged) return startupLog(`graphics card failed (${why}); a packaged build would restart without it`)
  fallingBack = true
  startupLog(`graphics card failed (${why}): restarting without it`)
  // A forced "on" that leaves the window white is no use either; go back to the automatic choice.
  updatePrefs({ graphicsFailed: true, ...(getPrefs().graphics === 'on' ? { graphics: 'auto' as const } : {}) })
  app.relaunch()
  app.quit()
}

/** After app ready: log what Chromium found, and react to a failing GPU process. */
export function watchGraphics(): void {
  try {
    const f = app.getGPUFeatureStatus()
    startupLog(`gpu features: compositing ${f.gpu_compositing}, rasterization ${f.rasterization}, webgl ${f.webgl}`)
  } catch {
    // Not available on every system.
  }
  void app
    .getGPUInfo('basic')
    .then((info) => {
      const gpu = info as { gpuDevice?: Array<{ vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }> }
      for (const d of gpu.gpuDevice ?? []) {
        startupLog(`gpu: vendor 0x${(d.vendorId ?? 0).toString(16)} device 0x${(d.deviceId ?? 0).toString(16)} driver ${d.driverVersion ?? '?'}${d.active ? ' (active)' : ''}`)
      }
    })
    .catch((err: unknown) => startupLog(`gpu info: ${err instanceof Error ? err.message : String(err)}`))

  app.on('child-process-gone', (_e, d) => {
    if (d.type !== 'GPU') return
    startupLog(`gpu process gone: ${d.reason} (exit code ${d.exitCode})`)
    // Before the first screen showed, a failing GPU process means a white window: start again in software.
    // Later, Chromium restarts it by itself; three failures in one session still mean the next start goes without.
    if (!isGpuFailure(d.reason)) return
    if (!painted) fallBack(`gpu process ${d.reason}`)
    else if (++gpuFailures >= 3 && status.hardware) {
      startupLog('graphics card failed three times: the next start goes without it')
      updatePrefs({ graphicsFailed: true })
    }
  })
}

/** Watch the main window: it must report its first screen, and its page must not crash unnoticed. */
export function watchWindow(win: BrowserWindow, { hidden = false } = {}): void {
  // A window started hidden (in the background for a Claude app) may not draw until it is shown.
  const timer = setTimeout(() => {
    if (!painted && !hidden) {
      startupLog(`no first screen after ${PAINT_TIMEOUT_MS / 1000} s`)
      fallBack('no first screen')
    }
  }, PAINT_TIMEOUT_MS)
  const wc = win.webContents
  wc.on('did-finish-load', () => startupLog('interface loaded'))
  wc.on('did-fail-load', (_e, code, description) => startupLog(`interface failed to load: ${code} ${description}`))
  wc.on('preload-error', (_e, _path, err) => startupLog(`preload error: ${err.message}`))
  // Errors before the first screen explain a blank window; later ones may mention your data, so they stay out.
  wc.on('console-message', (e) => {
    if (!painted && e.level === 'error') startupLog(`interface error: ${e.message.slice(0, 300)}`)
  })
  let reloaded = false
  wc.on('render-process-gone', (_e, d) => {
    startupLog(`interface process gone: ${d.reason} (exit code ${d.exitCode})`)
    if (d.reason === 'clean-exit' || win.isDestroyed()) return
    // Once, load the interface again instead of leaving an empty window.
    if (!reloaded) {
      reloaded = true
      wc.reload()
    }
  })
  win.once('closed', () => clearTimeout(timer))
}

/** The main window reported its first screen. */
export function markPainted(): void {
  if (painted) return
  painted = true
  startupLog('first screen shown')
}
