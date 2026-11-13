/** The launch window: appears at once, shows real start-up progress, closes when the app is ready. */
import { BrowserWindow, nativeTheme } from 'electron'
import icon from '../../resources/icon.png?asset'
import splashFile from '../../resources/splash.html?asset'
import { THEME_COLORS } from './theme'

let splash: BrowserWindow | null = null
let last = 0
let shownAt = 0
/** Shown at least this long, so a fast start doesn't look like a flicker. */
const MIN_VISIBLE_MS = 700

export function showSplash(theme: 'system' | 'light' | 'dark'): void {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  splash = new BrowserWindow({
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
  void splash.loadFile(splashFile, { query: { theme: dark ? 'dark' : 'light' } })
  splash.on('closed', () => (splash = null))
  shownAt = Date.now()
}

/** Resolves when the launch window has been visible long enough. */
export function splashMinimumElapsed(): Promise<void> {
  const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt))
  return new Promise((r) => setTimeout(r, splash ? wait : 0))
}

/** Moves the bar forward (never back) and names the current step. */
export function splashProgress(fraction: number, text: string): void {
  if (!splash || splash.isDestroyed()) return
  last = Math.max(last, fraction)
  const js = `window.kasboekProgress && window.kasboekProgress(${last}, ${JSON.stringify(text)})`
  const run = (): void => void splash?.webContents.executeJavaScript(js).catch(() => {})
  if (splash.webContents.isLoading()) splash.webContents.once('did-finish-load', run)
  else run()
}

export function closeSplash(): void {
  if (!splash || splash.isDestroyed()) return
  splashProgress(1, 'Ready')
  const s = splash
  splash = null
  setTimeout(() => s.isDestroyed() || s.close(), 150)
}
