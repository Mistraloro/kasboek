import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { cancelRunningJobs, dispatch, ensureSyncScheduler, onAppReady, registerIpc, startUpdateChecks } from './ipc'
import { stopMcpBridge, syncMcpBridge } from './mcp/bridge'
import { paths } from './paths'
import { hasTray, initTray, refreshTray, stopTray, syncTray } from './tray'
import { quitWhenAllWindowsClosed, shouldHideOnClose } from '@shared/window-policy'
import { startAlertChecks } from './notify'
import { isDevRendererUrl } from './trusted-url'
import { closeSplash, splashMinimumElapsed, splashStep } from './splash'
import { MAIN_WINDOW_SAFETY_MS, shouldShowMainWindow } from './startup-plan'
import { startupLog, watchGraphics, watchWindow } from './graphics'
import { getPrefs } from './prefs'
import { clearImportSessions } from '@core/import'
import { lock, onLock, startAutoLock, startDeferredChecks, startSession } from './session'
import { startBackupScheduler } from './transfer/scheduler'
import { applyTheme, initThemeSync, resolvedTheme, THEME_COLORS, TITLEBAR_HEIGHT, trackOverlay } from './theme'

paths.rendererDir = join(__dirname, '../renderer')

let mainWindow: BrowserWindow | null = null
let quitting = false
/** The first screen is ready: from here on the window may be shown. */
let revealed = false
/** Someone launched Kasboek again before the window was ready (only matters when it started in the tray). */
let showRequested = false

function createWindow(hidden = false): BrowserWindow {
  const colors = THEME_COLORS[resolvedTheme()]
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Kasboek',
    icon,
    backgroundColor: colors.bg,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: colors.bg, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  mainWindow = win
  win.on('closed', () => (mainWindow = null))
  // Closing keeps Kasboek in the tray only when the person chose that; otherwise it quits (macOS keeps the app in the Dock).
  win.on('close', (e) => {
    if (!shouldHideOnClose({ keepInTray: getPrefs().keepInTray, quitting, hasTray: hasTray() })) return
    e.preventDefault()
    win.hide()
  })
  if (!isMac) trackOverlay(win)
  watchWindow(win, { hidden })
  // Created hidden and shown when the page reports its first screen is drawn (see startApp), so it never appears blank.
  win.webContents.once('dom-ready', () => splashStep('interface-script-run'))
  startupLog('main window created')
  splashStep('main-window-created')

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(paths.rendererDir, 'index.html'))
  return win
}

/** Locks the app down: no navigation away, no pop-ups, no camera/mic/etc. */
function harden(): void {
  // Only writing to the clipboard is allowed (the Copy button for the recovery key).
  const allowed = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm))
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (!isDevRendererUrl(url, process.env['ELECTRON_RENDERER_URL'], app.isPackaged)) e.preventDefault()
    })
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/**
 * Brings the main window to the front: opens it again if it was closed (macOS), shows it if it was
 * hidden in the tray, restores it from the taskbar, focuses it. A window that is still starting
 * shows itself when ready.
 */
export function showMainWindow(): void {
  if (!revealed) {
    showRequested = true
    return
  }
  let win = mainWindow
  if (!win || win.isDestroyed()) {
    win = createWindow()
    const w = win
    w.once('ready-to-show', () => w.show())
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Everything after the launch window: loaded once Electron is ready (see index.ts). */
export async function startApp({ background }: { background: boolean }): Promise<void> {
  writeAppCommand()
  app.on('before-quit', () => {
    quitting = true
    stopTray()
  })
  harden()
  watchGraphics()
  initThemeSync()
  applyTheme(getPrefs().theme)
  startupLog('opening data')
  // The account is read while the window is created and its page loads; operations that need it wait (see dispatch).
  const dataOpened = startSession()
  // Running jobs are stopped before the database closes: their writes are all synchronous after an await that checks the signal.
  onLock(() => {
    cancelRunningJobs()
    clearImportSessions()
  })
  registerIpc()
  const win = createWindow(background)
  await dataOpened
  startupLog('data opened')
  splashStep('data-opened')
  let shown = false
  const reveal = (why: string): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    splashStep('first-screen')
    void splashMinimumElapsed().then(() => {
      if (win.isDestroyed()) return
      revealed = true
      if (shouldShowMainWindow({ background, showRequested })) win.show()
      closeSplash()
      startupLog(`main window ${win.isVisible() ? 'shown' : 'kept hidden (background start)'}: ${why}`)
      afterFirstScreen()
    })
  }
  onAppReady(() => reveal('first screen'))
  // Never leave the person with only the launch window.
  setTimeout(() => {
    if (!shown) startupLog(`showing the window without a first screen (${MAIN_WINDOW_SAFETY_MS / 1000} s)`)
    reveal('safety timeout')
  }, MAIN_WINDOW_SAFETY_MS)
  startBackupScheduler()
  startAutoLock()
  startAlertChecks()
  // Keep the MCP bridge in step with the lock state and the setting.
  initTray({ startedInTray: background, open: showMainWindow })
  const keepInStep = setInterval(() => {
    if (quitting) return
    syncMcpBridge(dispatch)
    syncTray()
    refreshTray()
  }, 2000)

  app.on('activate', showMainWindow)

  app.on('window-all-closed', () => {
    if (quitWhenAllWindowsClosed(process.platform)) app.quit()
  })

  app.on('will-quit', () => {
    clearInterval(keepInStep)
    stopTray()
    stopMcpBridge()
    lock('user', true)
  })
}

/** What can wait until the first screen is up: the Windows Hello check, sync and update checks (modules loaded only now). */
function afterFirstScreen(): void {
  startDeferredChecks()
  void ensureSyncScheduler()
  startUpdateChecks().catch((err: unknown) => startupLog(`update checks could not start: ${err instanceof Error ? err.message : String(err)}`))
}

/** How the kasboek-mcp helper can start Kasboek when a Claude app wants it (see tools/kasboek-mcp/launch.go). */
function writeAppCommand(): void {
  const exe = process.env['APPIMAGE'] ?? process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  try {
    writeFileSync(join(paths.dataDir, 'app.json'), JSON.stringify({ exe, args }))
  } catch {
    // Only needed for starting Kasboek from a Claude app.
  }
}
