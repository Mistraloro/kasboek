/**
 * Drawing with or without the graphics card, and a small start-up log.
 *
 * Some graphics drivers (notably on Windows on ARM / Snapdragon) leave Chromium-based windows white.
 * Kasboek then draws in software: by default on Windows on ARM, by choice in Settings, or by itself
 * after the graphics card failed to show the window. The log (startup.log in the data folder) holds
 * only technical facts (version, system, graphics, start-up steps), never your data.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { decideGraphics, isGpuFailure, type GraphicsChoice, type GraphicsStatus } from '@shared/graphics'
import { paths } from './paths'
import { getPrefs, updatePrefs } from './prefs'
import { formatLogLine, isFirstStartOfVersion, LogBuffer, rotateLog, startGap } from './startup-plan'

/** The main window must report its first screen within this time, or the graphics card gets the blame. */
const PAINT_TIMEOUT_MS = 15_000

let status: GraphicsStatus = { hardware: true, reason: null }
let painted = false
let fallingBack = false
let gpuFailures = 0

const logFile = (): string => join(paths.dataDir, 'startup.log')
const prevLogFile = (): string => join(paths.dataDir, 'startup.prev.log')
/** The version that last started, to tell the first start after an update (cold caches, new files to scan). */
const versionMarker = (): string => join(paths.dataDir, 'startup.version')

const logBuffer = new LogBuffer((text) => appendFileSync(logFile(), text))

/** One line in startup.log, with the time since start. Written in batches; see flushStartupLog. */
export function startupLog(text: string): void {
  logBuffer.add(formatLogLine(process.uptime(), text))
}

/** Writes the waiting lines to the file now (before the app quits or restarts). */
export function flushStartupLog(): void {
  logBuffer.flush()
}

interface StoredPrefs {
  choice: GraphicsChoice
  failedBefore: boolean
  theme: 'system' | 'light' | 'dark'
}
let stored: StoredPrefs = { choice: 'auto', failedBefore: false, theme: 'system' }

/** Read once straight from prefs.json: this runs before the app is ready, and the launch window reuses the theme. */
function readStoredPrefs(): StoredPrefs {
  try {
    if (existsSync(paths.prefsFile)) {
      const raw = JSON.parse(readFileSync(paths.prefsFile, 'utf8')) as { graphics?: unknown; graphicsFailed?: unknown; theme?: unknown }
      return {
        choice: raw.graphics === 'on' || raw.graphics === 'off' ? raw.graphics : 'auto',
        failedBefore: raw.graphicsFailed === true,
        theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system'
      }
    }
  } catch {
    // Unreadable prefs: the automatic choice.
  }
  return { choice: 'auto', failedBefore: false, theme: 'system' }
}

/** The saved theme, for the launch window (valid after applyGraphicsChoice). */
export function storedTheme(): StoredPrefs['theme'] {
  return stored.theme
}

/** Whether this is the first start of this version; remembers the version for the next start. */
function firstStartOfThisVersion(): boolean {
  let previous: string | null = null
  try {
    previous = readFileSync(versionMarker(), 'utf8')
  } catch {
    // No marker yet: a first start.
  }
  const first = isFirstStartOfVersion(previous, app.getVersion())
  if (first) {
    try {
      writeFileSync(versionMarker(), app.getVersion())
    } catch {
      // Only used for the log.
    }
  }
  return first
}

/** Call at the top of the main process, before the app is ready. */
export function applyGraphicsChoice(): void {
  stored = readStoredPrefs()
  status = decideGraphics({ choice: stored.choice, failedBefore: stored.failedBefore, platform: process.platform, arch: process.arch, disableGpuFlag: app.commandLine.hasSwitch('disable-gpu') })
  if (!status.hardware) app.disableHardwareAcceleration()
  try {
    mkdirSync(paths.dataDir, { recursive: true })
  } catch {
    // The log is a convenience.
  }
  rotateLog({ exists: existsSync, rename: renameSync, write: writeFileSync }, logFile(), prevLogFile())
  process.on('exit', flushStartupLog)
  startupLog(`Kasboek ${app.getVersion()} on ${process.platform} ${process.arch} (${release()}), Electron ${process.versions.electron}`)
  startupLog(`started ${new Date().toISOString()}; ${firstStartOfThisVersion() ? 'first start of this version' : 'not the first start of this version'}`)
  startupLog(`graphics: choice ${stored.choice}${stored.failedBefore ? ', failed before' : ''} -> ${graphicsText()}`)
  startupLog('main script started')
}

/** "graphics card" or "software (why)", for the log. */
function graphicsText(): string {
  return status.hardware ? 'graphics card' : `software (${status.reason})`
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
  flushStartupLog()
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
  wc.once('dom-ready', () => startupLog(`interface script run (dom-ready), process id ${wc.getOSProcessId()}`))
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
  startupLog(`first screen shown (drawing with ${graphicsText()})`)
  try {
    // What the operating system says about when this program was created: the time before our script is otherwise invisible.
    const created = app.getAppMetrics().find((m) => m.type === 'Browser')?.creationTime
    const gap = startGap(created, Date.now(), process.uptime())
    if (gap) startupLog(`before the log: the program started ${gap.beforeScriptMs} ms before the main script; first screen ${gap.sinceCreatedMs} ms after the program started`)
  } catch {
    // Only a measurement.
  }
}
