import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount, type AccountData, type Vault } from '@core/account'
import { setPasswordKdfForTests } from '@core/crypto'
import { openDatabase, type Db } from '@core/database'
import { getSettings } from '@core/settings'
import { openTransfer } from '@core/transfer-format'

beforeAll(() => setPasswordKdfForTests({ m: 1024, t: 1, p: 1 }))

// All data here is invented.
const state = vi.hoisted(() => ({
  dir: '',
  unlocked: true,
  /** Runs at the first wait on the disk (reading the snapshot or writing the file), like a lock that lands meanwhile. */
  beforeWrite: null as (() => void) | null,
  failWrite: false,
  secrets: null as unknown,
  db: null as unknown
}))

vi.mock('electron', () => ({ app: { getPath: () => state.dir, getVersion: () => '1.0.0', isPackaged: false } }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  const wait = (): void => {
    const hook = state.beforeWrite
    state.beforeWrite = null
    hook?.()
  }
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      wait()
      return real.readFile(...args)
    }) as typeof real.readFile,
    writeFile: (async (...args: Parameters<typeof real.writeFile>) => {
      wait()
      if (state.failWrite) throw new Error('disk full')
      return real.writeFile(...args)
    }) as typeof real.writeFile
  }
})
vi.mock('../src/main/session', () => ({
  secrets: () => state.secrets,
  db: () => {
    if (!state.unlocked) throw new Error('locked')
    return state.db
  },
  isUnlocked: () => state.unlocked,
  adopt: vi.fn(),
  closeForReplace: vi.fn()
}))

async function unlockedSession(): Promise<{ db: Db; master: Buffer; folder: string }> {
  state.dir = mkdtempSync(join(tmpdir(), 'kb-tl-'))
  const folder = join(state.dir, 'out')
  mkdirSync(folder)
  const dbKey = randomBytes(32).toString('hex')
  const db = openDatabase(join(state.dir, 'k.db'), dbKey)
  const made = await createAccount({ mode: 'password', password: 'a long password', dbKey })
  state.secrets = { account: made.account as AccountData, master: made.master, vault: made.vault as Vault }
  state.db = db
  state.unlocked = true
  state.beforeWrite = null
  state.failWrite = false
  return { db, master: made.master, folder }
}

describe('a backup while the app locks', () => {
  it('is encrypted before anything waits, so a lock during the write cannot zero its key', async () => {
    const { db, master, folder } = await unlockedSession()
    const original = Buffer.from(master)
    const { writeTransfer } = await import('../src/main/transfer/service')
    state.beforeWrite = () => {
      // What lock() does: the key is wiped and the database closes.
      master.fill(0)
      state.unlocked = false
    }
    const file = join(folder, 'backup.kasboek')
    await writeTransfer(file, 'backup')
    expect(master.equals(original)).toBe(false)
    const opened = await openTransfer(readFileSync(file), { password: 'a long password' })
    expect(opened.master.equals(original)).toBe(true)
    // The database was closed by then: nothing is recorded in it.
    state.unlocked = true
    expect(getSettings(db).lastBackupFile).toBeNull()
  })

  it('records the backup when still unlocked', async () => {
    const { db, folder } = await unlockedSession()
    const { writeTransfer } = await import('../src/main/transfer/service')
    const file = join(folder, 'backup.kasboek')
    await writeTransfer(file, 'backup')
    expect(getSettings(db).lastBackupFile).toBe(file)
  })

  it('leaves no half-written file behind when the write fails', async () => {
    const { folder } = await unlockedSession()
    const { writeTransfer } = await import('../src/main/transfer/service')
    state.failWrite = true
    await expect(writeTransfer(join(folder, 'backup.kasboek'), 'backup')).rejects.toThrow('disk full')
    expect(readdirSync(folder)).toEqual([])
    expect(existsSync(join(folder, 'backup.kasboek'))).toBe(false)
    expect(readdirSync(state.dir).filter((n) => n.startsWith('snapshot-'))).toEqual([])
  })
})
