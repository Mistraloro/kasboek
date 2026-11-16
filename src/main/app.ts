import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { dispatch, onAppReady, registerIpc } from './ipc'
import { mcpClientsSeen, stopMcpBridge, syncMcpBridge } from './mcp/bridge'
import { paths } from './paths'
import { createTray, destroyTray, refreshTray } from './tray'
import { startAlertChecks } from './notify'
import { startUpdateChecks } from './update'
import { closeSplash, splashMinimumElapsed, splashProgress } from './splash'
import { startupLog, watchGraphics, watchWindow } from './graphics'
import { getPrefs } from './prefs'
import { clearImportSessions } from '@core/import'
import { initSession, lock, onLock, startAutoLock } from './session'
import { startBackupScheduler } from './transfer/scheduler'
import { startSyncScheduler } from './sync/service'
import { applyTheme, initThemeSync, resolvedTheme, THEME_COLORS, TITLEBAR_HEIGHT, trackOverlay } from './theme'

paths.rendererDir = join(__dirname, '../renderer')

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
  if (!isMac) trackOverlay(win)
  watchWindow(win, { hidden })
  // Shown when the page reports its first screen is drawn (see startApp), so it never appears blank.
  win.webContents.once('did-finish-load', () => splashProgress(0.8, 'Loading the interface…'))

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
      const dev = process.env['ELECTRON_RENDERER_URL']
      if (!(dev && url.startsWith(dev))) e.preventDefault()
    })
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/** Everything after the launch window: loaded once Electron is ready (see index.ts). */
export async function startApp({ background }: { background: boolean }): Promise<void> {
writeAppCommand()
app.on('second-instance', (_e, argv) => {
  // The kasboek-mcp helper starting Kasboek "in the background" while it already runs: nothing to do.
  if (argv.includes('--background')) return
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

  harden()
  watchGraphics()
  splashProgress(0.15, 'Starting…')
  initThemeSync()
  applyTheme(getPrefs().theme)
  splashProgress(0.3, 'Opening your data…')
  startupLog('opening data')
  await initSession()
  startupLog('data opened')
  onLock(clearImportSessions)
  splashProgress(0.55, 'Preparing…')
  registerIpc()
  const win = createWindow(background)
  let shown = false
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    splashProgress(0.95, 'Almost ready…')
    void splashMinimumElapsed().then(() => {
      if (win.isDestroyed()) return
      if (!background) win.show()
      closeSplash()
    })
  }
  onAppReady(reveal)
  // Never leave the person with only the launch window.
  setTimeout(() => {
    if (!shown) startupLog('showing the window without a first screen (20 s)')
    reveal()
  }, 20_000)
  startBackupScheduler()
  startSyncScheduler()
  startAutoLock()
  startAlertChecks()
  startUpdateChecks()
  // Keep the MCP bridge in step with the lock state and the setting.
  createTray()
  keepInTrayForClaude(win)
  setInterval(() => {
    syncMcpBridge(dispatch)
    refreshTray()
  }, 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow()
      w.once('ready-to-show', () => w.show())
    }
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  destroyTray()
  stopMcpBridge()
  lock('user', true)
})
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

/** A Claude app checked the connection within this time: it is still running. */
const CLAUDE_RECENT_MS = 30_000
let quitting = false

/**
 * Closing the window while a Claude app is connected keeps Kasboek in the tray (it still locks on
 * its own after the auto-lock time), so the Claude app keeps working and the tray icon shows it.
 * "Quit Kasboek" in the tray menu still quits.
 */
function keepInTrayForClaude(win: BrowserWindow): void {
  app.on('before-quit', () => (quitting = true))
  win.on('close', (e) => {
    if (quitting) return
    const seen = Object.values(mcpClientsSeen()).filter((t): t is number => typeof t === 'number')
    if (seen.some((t) => Date.now() - t < CLAUDE_RECENT_MS)) {
      e.preventDefault()
      win.hide()
    }
  })
}
