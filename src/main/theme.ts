import { BrowserWindow, nativeTheme } from 'electron'
import type { Theme } from '@shared/types'

export const THEME_COLORS = {
  light: { bg: '#FAFAF8', symbol: '#18201B' },
  dark: { bg: '#0E110F', symbol: '#E7ECE8' }
} as const

export const TITLEBAR_HEIGHT = 44

const hasOverlay = new Set<number>()
/** Marks a window created with titleBarOverlay, so theme changes recolour its buttons. */
export function trackOverlay(win: BrowserWindow): void {
  hasOverlay.add(win.id)
  win.on('closed', () => hasOverlay.delete(win.id))
}

export function resolvedTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Keeps the native parts (title bar buttons, menus, window background) in sync with the app theme. */
export function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  syncWindowChrome()
}

export function syncWindowChrome(): void {
  const colors = THEME_COLORS[resolvedTheme()]
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(colors.bg)
    // Only the main window has overlay title-bar buttons (the launch window has no frame at all).
    if (process.platform !== 'darwin' && hasOverlay.has(win.id)) {
      win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT })
    }
  }
}

export function initThemeSync(): void {
  nativeTheme.on('updated', syncWindowChrome)
}
