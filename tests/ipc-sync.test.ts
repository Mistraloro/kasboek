import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@core/database'

const sync = vi.hoisted(() => ({ db: null as unknown, loads: 0, failLoad: true, start: vi.fn(), changedLocally: vi.fn(), onRemoteChanges: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'Kasboek', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => undefined },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {}
}))
vi.mock('../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../src/main/transfer/scheduler', () => ({ dataChanged: vi.fn(), unlocked: vi.fn() }))
vi.mock('../src/main/session', () => ({
  db: () => sync.db,
  isUnlocked: () => true,
  whenSessionReady: () => Promise.resolve(),
  broadcast: vi.fn(),
  onLock: vi.fn(),
  status: vi.fn()
}))
vi.mock('../src/main/sync/service', () => {
  sync.loads++
  if (sync.failLoad) throw new Error('module could not be loaded')
  return { startSyncScheduler: sync.start, changedLocally: sync.changedLocally, onRemoteChanges: sync.onRemoteChanges }
})

describe('sync wiring in ipc.ts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    sync.db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-ipcs-')), 'k.db'), randomBytes(32).toString('hex'))
  })

  it('a changing operation never loads the sync module and never fails because of it', async () => {
    const { dispatch } = await import('../src/main/ipc')
    // Not loaded yet: the change is simply not announced to sync.
    const result = await dispatch('settings.update', { currency: 'USD' }, 'user')
    expect(result.ok).toBe(true)
    expect(sync.loads).toBe(0)
  })

  it('tries again to start the sync timer after a failed start', async () => {
    const { ensureSyncScheduler } = await import('../src/main/ipc')
    await expect(ensureSyncScheduler()).resolves.toBeUndefined()
    expect(sync.start).not.toHaveBeenCalled()
    sync.failLoad = false
    await ensureSyncScheduler()
    expect(sync.start).toHaveBeenCalledTimes(1)
    await ensureSyncScheduler()
    expect(sync.start).toHaveBeenCalledTimes(1)
  })

  it('once the sync module is loaded, a changing operation tells it', async () => {
    const { dispatch, ensureSyncScheduler } = await import('../src/main/ipc')
    sync.failLoad = false
    await ensureSyncScheduler()
    expect(sync.changedLocally).not.toHaveBeenCalled()
    expect((await dispatch('settings.update', { currency: 'USD' }, 'user')).ok).toBe(true)
    expect(sync.changedLocally).toHaveBeenCalledTimes(1)
  })
})
