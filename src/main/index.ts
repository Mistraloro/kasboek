import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { dispatch, registerIpc } from './ipc'
import { stopMcpBridge, syncMcpBridge } from './mcp/bridge'
import { paths } from './paths'
import { getPrefs } from './prefs'
import { clearImportSessions } from '@core/import'
import { broadcast, initSession, lock, onLock, startAutoLock } from './session'
import { runAutoBackupIfDue } from './transfer/service'
import { applyTheme, initThemeSync, resolvedTheme, THEME_COLORS, TITLEBAR_HEIGHT } from './theme'

const MCP_MODE = process.argv.includes('--mcp')

// 64-bit only (x64 or ARM64): larger address space for ASLR, and the only builds we ship and test.
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  dialog.showErrorBox('Kasboek', 'Kasboek needs a 64-bit version of Windows, macOS or Linux.')
  app.exit(1)
}

// `--mcp` was the 0.9.0 way to start the MCP server. It can't work on Windows (a windowed app has no
// stdin), so it now points to the kasboek-mcp helper instead of starting a second copy of Kasboek.
if (MCP_MODE) {
  process.stderr.write('Kasboek: "--mcp" is no longer supported. In your MCP config, use the kasboek-mcp program that is installed next to Kasboek (see Kasboek → Settings → Claude).\n')
  app.exit(2)
} else if (!app.requestSingleInstanceLock()) {
  // One running copy only: two processes must never write the same database.
  app.quit()
}

app.setAppUserModelId('app.kasboek')
paths.rendererDir = join(__dirname, '../renderer')

function createWindow(): BrowserWindow {
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
  win.once('ready-to-show', () => win.show())

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

function scheduleAutoBackups(): void {
  const tick = (): void => {
    runAutoBackupIfDue()
      .then((file) => file && broadcast({ type: 'backup.completed', file }))
      .catch((err: unknown) => broadcast({ type: 'backup.failed', message: err instanceof Error ? err.message : String(err) }))
  }
  setTimeout(tick, 15_000)
  setInterval(tick, 60 * 60_000)
}

if (!MCP_MODE) startApp()

function startApp(): void {
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

void app.whenReady().then(async () => {
  harden()
  await initSession()
  onLock(clearImportSessions)
  initThemeSync()
  applyTheme(getPrefs().theme)
  registerIpc()
  createWindow()
  scheduleAutoBackups()
  startAutoLock()
  // Keep the MCP bridge in step with the lock state and the setting.
  setInterval(() => syncMcpBridge(dispatch), 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  stopMcpBridge()
  lock('user', true)
})
}
