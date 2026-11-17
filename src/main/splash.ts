/** The launch window: appears at once, shows real start-up progress, closes when the main window is shown. */
import { BrowserWindow, nativeTheme } from 'electron'
import icon from '../../resources/icon.png?asset'
import splashFile from '../../resources/splash.html?asset'
import { startupLog } from './graphics'
import { PAINTED_SCRIPT, progressScript, splashUrl } from './splash-page'
import { laterStep, progressAt, PROGRESS_STEPS, stepText, type ProgressStep } from './startup-plan'
import { THEME_COLORS } from './theme'

let splash: BrowserWindow | null = null
let step: ProgressStep = 'begin'
let stepAt = 0
let shownAt = 0
let last = 0
/** The page has loaded: progress can be set in it. */
let loaded = false
let creep: NodeJS.Timeout | null = null
/** Shown at least this long, so a fast start doesn't look like a flicker. */
const MIN_VISIBLE_MS = 700
/** How often the bar creeps forward between two real steps. */
const CREEP_TICK_MS = 400

/**
 * Shows the launch window. Resolves (the returned promise) once the page has really been drawn, or
 * when it can not be, so the caller may wait for it without ever getting stuck.
 */
export function showSplash(theme: 'system' | 'light' | 'dark'): Promise<void> {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  const win = new BrowserWindow({
    width: 380,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    show: true,
    center: true,
    icon,
    title: 'Kasboek',
    backgroundColor: THEME_COLORS[dark ? 'dark' : 'light'].bg,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  splash = win
  loaded = false
  shownAt = Date.now()
  stepAt = shownAt
  startupLog('launch window created')
  const wc = win.webContents
  // The page is fixed; nothing may take it anywhere else or open anything.
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const painted = new Promise<void>((resolve) => {
    let usedFallback = false
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      startupLog(`launch window failed to load: ${code} ${description}`)
      // The page from a file: slower, but it works where an inline page does not.
      if (!usedFallback) {
        usedFallback = true
        void win.loadFile(splashFile, { query: { theme: dark ? 'dark' : 'light' } }).catch(() => resolve())
      } else resolve()
    })
    wc.once('did-finish-load', () => {
      loaded = true
      startupLog(`launch window loaded, process id ${wc.getOSProcessId()}`)
      splashStep('launch-window-loaded')
      wc.executeJavaScript(PAINTED_SCRIPT).then(
        () => {
          startupLog('launch window painted')
          resolve()
        },
        () => resolve()
      )
    })
    win.once('closed', () => resolve())
  })
  void win.loadURL(splashUrl(dark)).catch(() => {
    // did-fail-load above handles it.
  })
  win.on('closed', () => {
    splash = null
    stopCreep()
  })
  startCreep()
  return painted
}

function splashAlive(): BrowserWindow | null {
  return splash && !splash.isDestroyed() ? splash : null
}

function paint(fraction: number, text: string): void {
  const win = splashAlive()
  if (!win || !loaded) return
  last = Math.max(last, fraction)
  win.webContents.executeJavaScript(progressScript(last, text)).catch(() => {})
}

function startCreep(): void {
  creep = setInterval(() => paint(progressAt(step, Date.now() - stepAt), stepText(step)), CREEP_TICK_MS)
  creep.unref()
}

function stopCreep(): void {
  if (creep) clearInterval(creep)
  creep = null
}

/** A real step happened: the bar moves to it (never back) and then creeps toward the next one. */
export function splashStep(next: ProgressStep): void {
  const later = laterStep(step, next)
  if (later === step) return
  step = later
  stepAt = Date.now()
  paint(PROGRESS_STEPS.find((s) => s.id === step)!.at, stepText(step))
}

/** Resolves when the launch window has been visible long enough. */
export function splashMinimumElapsed(): Promise<void> {
  const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt))
  return new Promise((r) => setTimeout(r, splashAlive() ? wait : 0))
}

export function closeSplash(): void {
  const s = splashAlive()
  if (!s) return
  stopCreep()
  paint(1, 'Ready')
  splash = null
  setTimeout(() => s.isDestroyed() || s.close(), 150)
}
