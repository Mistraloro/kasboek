import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, systemPreferences: {} }))
vi.mock('../src/main/graphics', () => ({ startupLog: vi.fn() }))

// A fake check: answers at once, and is counted. The module keeps state, so each test loads it fresh.
async function load() {
  vi.resetModules()
  return import('../src/main/security/device-auth')
}

describe('Windows Hello check at start-up', () => {
  beforeEach(() => {
    vi.stubEnv('KASBOEK_FAKE_DEVICE_AUTH', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('decides when the background check may start', async () => {
    const { mayCheckNow } = await load()
    expect(mayCheckNow({ held: true, deviceMode: false })).toBe(false)
    expect(mayCheckNow({ held: true, deviceMode: true })).toBe(true)
    expect(mayCheckNow({ held: false, deviceMode: false })).toBe(true)
  })

  it('does not start before the first screen, and the page sees "still checking"', async () => {
    const { peekDeviceAuthKind } = await load()
    const done = vi.fn()
    expect(peekDeviceAuthKind(done)).toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(peekDeviceAuthKind(done)).toBeUndefined()
    expect(done).not.toHaveBeenCalled()
  })

  it('starts after the release, then answers and tells the page', async () => {
    const { peekDeviceAuthKind, releaseDeviceCheck } = await load()
    const done = vi.fn()
    expect(peekDeviceAuthKind(done)).toBeUndefined()
    releaseDeviceCheck()
    // The fake check answers within the call; a real one answers later and the page is told by the callback.
    expect(peekDeviceAuthKind(done)).toBe(process.platform === 'darwin' ? 'touch-id' : 'windows-hello')
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  })

  it('starts at once for a passwordless account, which the Lock screen needs', async () => {
    const { peekDeviceAuthKind } = await load()
    const done = vi.fn()
    expect(peekDeviceAuthKind(done, { deviceMode: true })).not.toBeUndefined()
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  })

  it('does not hold back a check that a prompt needs (deviceAuthKind itself)', async () => {
    const { deviceAuthKind } = await load()
    await expect(deviceAuthKind()).resolves.toBe(process.platform === 'darwin' ? 'touch-id' : 'windows-hello')
  })
})
