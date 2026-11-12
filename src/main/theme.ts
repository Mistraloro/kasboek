import { BrowserWindow, nativeTheme } from 'electron'
import type { Theme } from '@shared/types'

export const THEME_COLORS = {
  light: { bg: '#FAFAF8', symbol: '#18201B' },
  dark: { bg: '#0E110F', symbol: '#E7ECE8' }
} as const

export const TITLEBAR_HEIGHT = 44

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
    if (process.platform !== 'darwin') {
      win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT })
    }
  }
}

export function initThemeSync(): void {
  nativeTheme.on('updated', syncWindowChrome)
}
