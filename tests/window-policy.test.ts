import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS } from '../src/main/prefs'
import {
  isBackgroundLaunch,
  mustShowOnSecondInstance,
  quitWhenAllWindowsClosed,
  shouldHideOnClose,
  trayWanted
} from '../src/shared/window-policy'

describe('keepInTray default', () => {
  it('is off unless the person turns it on', () => {
    expect(DEFAULT_PREFS.keepInTray).toBe(false)
    // Stored prefs from before the setting existed have no key: the defaults fill it in.
    const stored: Partial<typeof DEFAULT_PREFS> = { theme: 'dark' }
    expect({ ...DEFAULT_PREFS, ...stored }.keepInTray).toBe(false)
  })
})

describe('shouldHideOnClose', () => {
  const base = { keepInTray: true, quitting: false, hasTray: true }
  it('hides to the tray only when chosen', () => {
    expect(shouldHideOnClose(base)).toBe(true)
    expect(shouldHideOnClose({ ...base, keepInTray: false })).toBe(false)
  })
  it('never blocks a real quit', () => {
    expect(shouldHideOnClose({ ...base, quitting: true })).toBe(false)
  })
  it('does not hide the window when there is no tray icon to open it again', () => {
    expect(shouldHideOnClose({ ...base, hasTray: false })).toBe(false)
  })
})

describe('quitWhenAllWindowsClosed', () => {
  it('quits on Windows and Linux, stays in the Dock on macOS', () => {
    expect(quitWhenAllWindowsClosed('win32')).toBe(true)
    expect(quitWhenAllWindowsClosed('linux')).toBe(true)
    expect(quitWhenAllWindowsClosed('darwin')).toBe(false)
  })
})

describe('second launch', () => {
  it('shows the window for a normal launch (shortcut, Start menu, Kasboek.exe)', () => {
    expect(mustShowOnSecondInstance(['C:\\Kasboek\\Kasboek.exe'])).toBe(true)
    expect(mustShowOnSecondInstance(['kasboek', '--some-flag'])).toBe(true)
  })
  it('leaves the window alone for the Claude helper checking that Kasboek runs', () => {
    expect(mustShowOnSecondInstance(['Kasboek.exe', '--background'])).toBe(false)
  })
})

describe('start mode', () => {
  it('starts in the tray only when asked with the flag', () => {
    expect(isBackgroundLaunch(['Kasboek.exe'])).toBe(false)
    expect(isBackgroundLaunch([])).toBe(false)
    expect(isBackgroundLaunch(['Kasboek.exe', '--background'])).toBe(true)
  })
})

describe('trayWanted', () => {
  it('shows the icon only when kept in the tray or started there by Claude', () => {
    expect(trayWanted({ keepInTray: false, startedInTray: false })).toBe(false)
    expect(trayWanted({ keepInTray: true, startedInTray: false })).toBe(true)
    expect(trayWanted({ keepInTray: false, startedInTray: true })).toBe(true)
    expect(trayWanted({ keepInTray: true, startedInTray: true })).toBe(true)
  })
  it('never shows the icon while Kasboek is shutting down', () => {
    expect(trayWanted({ keepInTray: true, startedInTray: true, shuttingDown: true })).toBe(false)
    expect(trayWanted({ keepInTray: true, startedInTray: false, shuttingDown: true })).toBe(false)
    expect(trayWanted({ keepInTray: true, startedInTray: false, shuttingDown: false })).toBe(true)
  })
})
