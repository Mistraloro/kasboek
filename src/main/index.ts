import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { openDatabase } from '@core/database'
import { getSettings } from '@core/settings'
import icon from '../../resources/icon.png?asset'
import { runAutoBackupIfDue } from './backup/service'
import { broadcast, registerIpc } from './ipc'
import { Keystore } from './security/keystore'
import { paths, state } from './state'
import { applyTheme, initThemeSync, resolvedTheme, THEME_COLORS, TITLEBAR_HEIGHT } from './theme'

// One running copy only: two processes must never write the same database.
if (!app.requestSingleInstanceLock()) app.quit()

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
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
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

async function openData(): Promise<void> {
  const keystore = await Keystore.load(paths.keystoreFile)
  state.keystore = keystore
  try {
    state.db = openDatabase(paths.dbFile, keystore.dbKey)
  } catch (err) {
    const message = keystore.created
      ? 'Kasboek could not create its database.'
      : 'Kasboek could not unlock its database on this computer. If you moved to a new computer or user account, restore from a backup file.'
    dialog.showErrorBox('Kasboek', `${message}\n\n${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
    throw err
  }
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

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

void app.whenReady().then(async () => {
  harden()
  await openData()
  initThemeSync()
  applyTheme(getSettings(state.db!).theme)
  registerIpc()
  createWindow()
  scheduleAutoBackups()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  state.db?.close()
  state.db = null
})
