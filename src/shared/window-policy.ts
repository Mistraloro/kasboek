/** Decisions about the main window, the tray icon and a second launch. Pure, so they can be tested. */

/** The kasboek-mcp helper starts Kasboek with this flag: only the tray icon, locked, no window. */
export const BACKGROUND_FLAG = '--background'

/** Started by a Claude app (and not by the person) when the command line says so. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_FLAG)
}

/**
 * Closing the main window keeps Kasboek running in the tray only when the person chose that, the
 * app is not already quitting, and a tray icon exists to open it again (some Linux desktops have none).
 */
export function shouldHideOnClose(o: { keepInTray: boolean; quitting: boolean; hasTray: boolean }): boolean {
  return o.keepInTray && !o.quitting && o.hasTray
}

/** Windows and Linux quit when the last window closes; macOS keeps the app in the Dock. */
export function quitWhenAllWindowsClosed(platform: string): boolean {
  return platform !== 'darwin'
}

/**
 * A second launch (shortcut, Start menu, taskbar, Kasboek.exe again) brings the window up, except
 * the Claude helper's own "start in the background" call, which only checks that Kasboek runs.
 */
export function mustShowOnSecondInstance(argv: readonly string[]): boolean {
  return !isBackgroundLaunch(argv)
}

/** The tray icon exists when the person keeps Kasboek in the tray, or a Claude app started it there. */
export function trayWanted(o: { keepInTray: boolean; startedInTray: boolean }): boolean {
  return o.keepInTray || o.startedInTray
}
