/**
 * Entry point, kept small: the launch window appears as soon as Electron is ready, and the rest of
 * Kasboek (database, assistant, sync, …) is loaded after that, while the window shows progress.
 */
import { app, dialog } from 'electron'
import { applyGraphicsChoice, startupLog, storedTheme } from './graphics'
import { isBackgroundLaunch, mustShowOnSecondInstance } from '@shared/window-policy'
import { closeSplash, showSplash, splashStep } from './splash'
import { SPLASH_HEAD_START_MS } from './startup-plan'

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
  app.whenReady().then(async () => {
    startupLog('electron ready')
    if (!BACKGROUND) {
      // The launch window gets a head start: the app code is a large file that blocks this thread while it loads.
      const painted = showSplash(storedTheme())
      await Promise.race([painted, new Promise<void>((r) => setTimeout(r, SPLASH_HEAD_START_MS))])
    } else startupLog('started in the background by a Claude app')
    const { startApp } = await import('./app')
    startupLog('app code loaded')
    splashStep('app-code-loaded')
    await startApp({ background: BACKGROUND })
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    startupLog(`start failed: ${message}`)
    closeSplash()
    dialog.showErrorBox('Kasboek', `Kasboek could not start.\n\n${message}`)
  })
}
