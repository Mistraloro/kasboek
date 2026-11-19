// The op contract as JSON for kb-core (rust/crates/kb-core/contract.json). The committed file must equal what the app's
// code says now; regenerate it when the contract changes:
//   KB_WRITE_CONTRACT=1 npx vitest run --config rust/parity/vitest.config.ts contract
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MockState } from './electron-mock'
import { dumpContract } from './dump-contract'

const state = vi.hoisted((): MockState => ({ userData: '', db: null, unlocked: false, languages: ['en'] }))
vi.mock('electron', async () => (await import('./electron-mock')).electronMock(state))
vi.mock('../../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../../src/main/session', async () => (await import('./electron-mock')).sessionMock(state))

const FILE = resolve(import.meta.dirname, '../crates/kb-core/contract.json')

describe('contract.json', () => {
  it('matches the contract of the app (154 operations)', async () => {
    const { allOps } = await import('../../src/main/ipc')
    const dumped = dumpContract(allOps) as { opCount: number; enums: { currencies: string[] } }
    expect(dumped.opCount).toBe(154)
    const text = JSON.stringify(dumped, null, 2) + '\n'
    if (process.env.KB_WRITE_CONTRACT === '1') writeFileSync(FILE, text)
    // The currency list comes from the ICU of the Node that runs this (Intl.supportedValuesOf), so it differs between
    // Node versions; the committed list is the static table kb-core uses (plan section 4). Everything else must match.
    const committed = JSON.parse(readFileSync(FILE, 'utf8')) as typeof dumped
    expect(committed.enums.currencies).toContain('EUR')
    expect(dumped.enums.currencies).toContain('EUR')
    const same = (x: typeof dumped) => ({ ...x, enums: { ...x.enums, currencies: [] } })
    expect(same(committed)).toEqual(same(dumped))
  })
})
