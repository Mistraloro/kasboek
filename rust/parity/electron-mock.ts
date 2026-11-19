// What the specs that import the app's own `src/main/ipc.ts` replace: Electron itself, the tray, the splash window and the
// session. Used through `vi.mock(..., () => ...)` factories in the spec files (a vi.mock call must sit in the spec).
import { vi } from 'vitest'

export interface MockState {
  /** The folder Electron's `app.getPath('userData')` returns (prefs.json lives there). */
  userData: string
  /** The database `session.db()` hands out; null while there is none. */
  db: unknown
  unlocked: boolean
  languages: string[]
}

export const electronMock = (state: MockState) => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => state.userData, getName: () => 'Kasboek', isPackaged: false, getPreferredSystemLanguages: () => state.languages },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => undefined },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  powerMonitor: { on: vi.fn() },
  nativeTheme: {}
})

export const sessionMock = (state: MockState) => ({
  db: () => state.db,
  isUnlocked: () => state.unlocked,
  whenSessionReady: () => Promise.resolve(),
  broadcast: vi.fn(),
  onLock: vi.fn(),
  status: vi.fn()
})
