/**
 * Entry point, kept small: the launch window appears as soon as Electron is ready, and the rest of
 * Kasboek (database, assistant, sync, …) is loaded after that, while the window shows progress.
 */
import { app, dialog } from 'electron'
import { applyGraphicsChoice, startupLog } from './graphics'
import { getPrefs } from './prefs'
import { isBackgroundLaunch, mustShowOnSecondInstance } from '@shared/window-policy'
import { showSplash, splashProgress } from './splash'

const MCP_MODE = process.argv.includes('--mcp')
// Started by the kasboek-mcp helper because a Claude app wants Kasboek: only the tray icon, locked.
const BACKGROUND = isBackgroundLaunch(process.argv)

// 64-bit only (x64 or ARM64): larger address space for ASLR, and the only builds we ship and test.
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  dialog.showErrorBox('Kasboek', 'Kasboek needs a 64-bit version of Windows, macOS or Linux.')
  app.exit(1)
}

// `--mcp` was the 0.9.0 way to start the MCP server. It can't work on Windows (a windowed app has no
// stdin), so it now points to the kasboek-mcp helper instead of starting a second copy of Kasboek.
if (MCP_MODE) {
  process.stderr.write('Kasboek: "--mcp" is no longer supported. In your MCP config, use the kasboek-mcp program that is installed next to Kasboek (see Kasboek → Settings → Assistant).\n')
  app.exit(2)
}
// One running copy only: two processes must never write the same database.
const firstCopy = !MCP_MODE && app.requestSingleInstanceLock()
if (!MCP_MODE && !firstCopy) app.quit()

app.setAppUserModelId('app.kasboek')

if (firstCopy) {
  // A second launch (shortcut, Start menu, Kasboek.exe again) hands over here and quits at once; this
  // copy brings its window up. Registered before the rest loads so an early hand-over is not missed.
  app.on('second-instance', (_e, argv) => {
    if (mustShowOnSecondInstance(argv)) void import('./app').then((m) => m.showMainWindow())
  })
  // Before the app is ready: whether to draw with the graphics card (see graphics.ts).
  applyGraphicsChoice()
  void app.whenReady().then(async () => {
    if (!BACKGROUND) {
      showSplash(getPrefs().theme)
      splashProgress(0.08, 'Starting…')
      startupLog('launch window shown')
    } else startupLog('started in the background by a Claude app')
    const { startApp } = await import('./app')
    await startApp({ background: BACKGROUND })
  })
}
