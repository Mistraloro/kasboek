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
  /** The answers of the file dialogs in the order they open (null: cancelled); set by the scenario runner from `dialogs`. */
  dialogs?: (string | null)[]
  /** The recorded network answers in order (`http` of a scenario); set by the scenario runner. */
  http?: HttpEntry[]
  /** The requests `net.fetch` saw; the scenario runner prints them. */
  requests?: { method: string; url: string; body: string | null }[]
}
export interface HttpEntry {
  url: string
  status?: number
  body?: string
  /** Event data strings, served as `data: <text>` lines each followed by a blank line (the same as the Rust FakeHttp). */
  sse?: string[]
}

const nextDialog = (state: MockState): string | null => state.dialogs?.shift() ?? null

async function fakeFetch(state: MockState, url: unknown, init?: { method?: string; body?: unknown }): Promise<Response> {
  const text = String(url)
  const body = init?.body
  state.requests?.push({ method: init?.method ?? 'GET', url: text, body: typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : null })
  const next = state.http?.shift()
  if (!next || next.url !== text) throw new Error(`unexpected request ${text}`)
  const served = next.sse ? next.sse.map((e) => `data: ${e}\n\n`).join('') : (next.body ?? '')
  return new Response(served, { status: next.status ?? 200 })
}

export const electronMock = (state: MockState) => ({
  net: { fetch: vi.fn((url: unknown, init?: { method?: string; body?: unknown }) => fakeFetch(state, url, init)) },
  app: { getPath: () => state.userData, getName: () => 'Kasboek', isPackaged: false, getPreferredSystemLanguages: () => state.languages },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => undefined },
  dialog: {
    // `showOpenDialog(win, opts)` or `showOpenDialog(opts)`; the folder picker is an open dialog too.
    showOpenDialog: async () => {
      const path = nextDialog(state)
      return { canceled: path === null, filePaths: path === null ? [] : [path] }
    },
    showSaveDialog: async () => {
      const path = nextDialog(state)
      return { canceled: path === null, filePath: path ?? undefined }
    }
  },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: async () => '', openExternal: async () => undefined },
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
