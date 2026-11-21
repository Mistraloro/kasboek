// Transfer parity, both directions, through the whole service on each side: the TypeScript app (src/main/transfer/service.ts on
// its real account code, with Electron and the session mocked) exports a file that the Rust service (`kb-cli scenario` with
// "service": true) picks and imports, and the other way round. The data that arrives must equal the data that left (a dump of
// every table but `settings` and `audit_log`, which an import resets or extends), for a password, the recovery key and a 2FA
// code; and the refusals (a wrong password, a KASBOEK1 file, a file that is no export, a file from a newer version) carry the same
// code and text on both sides. All secrets are invented.
// Needs: cargo build -p kb-cli (rust/target/{release,debug}/kb-cli, or KB_CLI_BIN).
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountData, Vault } from '@core/account'
import { totpAt } from '@core/totp'
import { load } from './compare'
import { cliText, tempDir } from './helpers'
import type { MockState } from './electron-mock'
import { dump, SCENARIO_KEY, type Outcome } from './scenario-runner'

process.env.TZ = 'UTC'
const state = vi.hoisted((): MockState => ({ userData: '', db: null, unlocked: true, languages: ['en'] }))
const adopted = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('electron', async () => (await import('./electron-mock')).electronMock(state))
vi.mock('../../src/main/tray', () => ({ syncTray: vi.fn() }))
vi.mock('../../src/main/splash', () => ({ splashStep: vi.fn() }))
vi.mock('../../src/main/session', async () => ({
  ...(await import('./electron-mock')).sessionMock(state),
  adopt: vi.fn(async (...args: unknown[]) => void adopted.calls.push(args)),
  closeForReplace: vi.fn()
}))

const PW = 'violet-Harbor-83-lantern'
const RUST_PASSWORD = 'correct horse battery 12'
const CLOCK = '2026-11-14T10:00:00Z'
const tmp = tempDir('kb-transfer-')
afterAll(() => tmp.remove())

/** The tables an import must reproduce. `settings` is reset by an import and `audit_log` gets its own entries. */
const moved = (d: Outcome['dump']): Outcome['dump'] => Object.fromEntries(Object.entries(d).filter(([name]) => name !== 'settings' && name !== 'audit_log'))

function rust(scenario: object): Outcome {
  const file = join(tmp.dir, `scenario-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify({ name: 'transfer parity', service: true, clock: CLOCK, ...scenario }))
  return JSON.parse(cliText(['scenario', file])) as Outcome
}

const ok = (o: Outcome, i: number): any => {
  const r = o.results[i] as { ok: boolean; data?: unknown; error?: unknown }
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r.data
}
const failed = (o: Outcome, i: number): { code: string; message: string } => {
  const r = o.results[i] as { ok: boolean; error?: { code: string; message: string } }
  expect(r.ok).toBe(false)
  return r.error!
}

interface Ts {
  dispatch: (op: string, input: unknown, actor: string) => Promise<any>
  db: Awaited<ReturnType<Awaited<ReturnType<typeof load>>['openDatabase']>>
  dir: string
  service: typeof import('../../src/main/transfer/service')
  secrets: { account: AccountData; master: Buffer; vault: Vault; recoveryKey: string }
}

/** A TypeScript app with an invented account and data. `totp` makes it a 2FA account. */
async function tsApp(opts: { totp?: string } = {}): Promise<Ts> {
  const app = await load()
  const crypto = await import('@core/crypto')
  crypto.setPasswordKdfForTests({ m: 64, t: 1, p: 1 })
  const account = await import('@core/account')
  const dir = join(tmp.dir, `ts-${Math.random().toString(36).slice(2)}`)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir)
  state.userData = dir
  state.languages = ['en']
  state.unlocked = true
  const db = app.openDatabase(join(dir, 'kasboek.db'), SCENARIO_KEY)
  state.db = db
  const created = await account.createAccount({ mode: 'password', password: PW, dbKey: SCENARIO_KEY })
  let { account: acc, vault } = created
  if (opts.totp) ({ account: acc, vault } = account.setTwoFactor(acc, created.master, vault, { secret: opts.totp, lastStep: -1 }))
  state.secrets = { account: acc, master: created.master, vault }
  const dispatch = app.dispatch as unknown as Ts['dispatch']
  const must = async (op: string, input: unknown): Promise<any> => {
    const r = await dispatch(op, input, 'user')
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r.data
  }
  const a = await must('accounts.create', { name: 'Checking', bank: 'Invented Bank', iban: 'BE68 5390 0754 7034', openingBalanceCents: 120000 })
  const b = await must('accounts.create', { name: 'Savings', bank: 'Invented Bank', iban: 'BE71 0961 2345 6769', openingBalanceCents: 500000 })
  for (const [i, desc] of ['Groceries', 'Rent', 'Coffee'].entries()) {
    await must('transactions.create', { accountId: i === 1 ? b.id : a.id, bookingDate: `2026-11-0${i + 1}`, amountCents: -(1000 + i * 2500), description: desc })
  }
  const service = await import('../../src/main/transfer/service')
  return { dispatch, db, dir, service, secrets: { account: acc, master: created.master, vault, recoveryKey: created.recoveryKey } }
}

async function tsExport(ts: Ts, file: string): Promise<void> {
  state.dialogs = [file]
  const r = await ts.dispatch('transfer.export', {}, 'user')
  expect(r).toEqual({ ok: true, data: { file } })
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(CLOCK))
})

describe('TypeScript exports, Rust imports', () => {
  const variants: { name: string; credentials: (ts: Ts) => object; totp?: string; recovery?: boolean }[] = [
    { name: 'with the password', credentials: () => ({ password: PW }) },
    { name: 'with the recovery key as typed', credentials: (ts) => ({ recoveryKey: ts.secrets.recoveryKey.toLowerCase().replaceAll('-', ' ') }), recovery: true },
    { name: 'with the password and a 2FA code', credentials: () => ({ password: PW, code: '$totp' }), totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
    { name: 'with the recovery key of a 2FA account (no code)', credentials: (ts) => ({ recoveryKey: ts.secrets.recoveryKey }), totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', recovery: true }
  ]
  for (const v of variants) {
    it(`moves the data ${v.name}`, async () => {
      const ts = await tsApp({ totp: v.totp })
      const file = join(tmp.dir, `ts-export-${Math.random().toString(36).slice(2)}.kasboek`)
      await tsExport(ts, file)
      const code = v.totp ? totpAt(v.totp, Date.parse(CLOCK) / 1000) : undefined
      const credentials = JSON.parse(JSON.stringify(v.credentials(ts)).replace('$totp', code ?? ''))
      const out = rust({
        dialogs: [file],
        steps: [{ op: 'transfer.pick' }, { op: 'transfer.import', input: { token: '$token', ...credentials } }, { op: 'accounts.list' }]
      })
      const picked = ok(out, 0)
      expect(picked).toMatchObject({ kind: 'export', mode: 'password', hasPassword: true, twoFactor: !!v.totp, needsNewPassword: false })
      const done = ok(out, 1)
      expect(done.status).toMatchObject({ state: 'unlocked', recovered: !!v.recovery })
      expect(ok(out, 2).map((a: { name: string }) => a.name)).toEqual(['Checking', 'Savings'])
      expect(moved(out.dump)).toEqual(moved(dump(ts.db)))
    })
  }

  it('resets what a file from elsewhere must not bring, and never switches the assistant on, the way the TypeScript import does', async () => {
    const a = await tsApp()
    state.dialogs = ['/somewhere/else']
    for (const [op, input] of [
      ['settings.update', { hideAccountNumbers: false, assistantEnabled: true }],
      ['backup.chooseFolder', {}],
      ['backup.configureAuto', { enabled: true, keep: 3 }]
    ] as const) {
      expect((await a.dispatch(op, input, 'user')).ok).toBe(true)
    }
    const file = join(tmp.dir, 'untrusted.kasboek')
    await tsExport(a, file)

    // The TypeScript import, on a computer where the assistant is off.
    const b = await tsApp()
    expect((await b.dispatch('settings.update', { assistantEnabled: false }, 'user')).ok).toBe(true)
    const picked = await b.service.describeTransfer(file)
    adopted.calls.length = 0
    const tsReset = await b.service.importTransfer({ token: picked.token, password: PW })
    const vault = (adopted.calls[0] as [AccountData, Buffer, Vault, boolean])[2]
    b.db.close()
    const imported = (await load()).openDatabase(join(b.dir, 'kasboek.db'), vault.dbKey)
    state.db = imported
    state.unlocked = true
    const tsSettings = (await ((await load()).dispatch as unknown as Ts['dispatch'])('settings.get', {}, 'user')).data
    imported.close()

    const out = rust({
      dialogs: [file],
      steps: [
        { op: 'settings.update', input: { assistantEnabled: false } },
        { op: 'transfer.pick' },
        { op: 'transfer.import', input: { token: '$token', password: PW } },
        { op: 'settings.get' }
      ]
    })
    expect(ok(out, 2).reset).toEqual(tsReset)
    expect(tsReset).toContain('autoBackup')
    expect(ok(out, 3)).toEqual(tsSettings)
    expect(tsSettings).toMatchObject({ assistantEnabled: false, hideAccountNumbers: true, autoBackupEnabled: false, autoBackupFolder: null })
  })

  it('refuses what is not an export with the codes and texts of the TypeScript app', async () => {
    const ts = await tsApp()
    const exported = join(tmp.dir, 'good.kasboek')
    await tsExport(ts, exported)
    const good = readFileSync(exported)
    const files: Record<string, Buffer> = {
      old: Buffer.concat([Buffer.from('KASBOEK1'), Buffer.from('\0\0\0\x05{"a":1}with more bytes after it')]),
      text: Buffer.from('just some text, not an export'),
      empty: Buffer.alloc(0),
      short: Buffer.concat([Buffer.from('KASBOEK2'), Buffer.from([0, 0, 0, 0])]),
      format3: (() => {
        const header = Buffer.from(JSON.stringify({ format: 3 }))
        const len = Buffer.alloc(4)
        len.writeUInt32BE(header.length)
        return Buffer.concat([Buffer.from('KASBOEK2'), len, header, Buffer.alloc(32)])
      })()
    }
    const paths = Object.entries(files).map(([name, bytes]) => {
      const p = join(tmp.dir, `${name}.kasboek`)
      writeFileSync(p, bytes)
      return p
    })
    const out = rust({ dialogs: paths, steps: paths.map(() => ({ op: 'transfer.pick' })) })
    for (const [i, p] of paths.entries()) {
      state.dialogs = [p]
      const r = await ts.dispatch('transfer.pick', {}, 'user')
      expect(r.ok).toBe(false)
      expect(failed(out, i), p).toEqual(r.error)
    }
    expect(good.subarray(0, 8).toString()).toBe('KASBOEK2')
  })

  it('answers a wrong password, a wrong 2FA code and a wrong recovery key with the same error', async () => {
    const totp = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const ts = await tsApp({ totp })
    const file = join(tmp.dir, 'wrong.kasboek')
    await tsExport(ts, file)
    const inputs = [
      { password: 'not the password 12', code: totpAt(totp, Date.parse(CLOCK) / 1000) },
      { password: PW, code: '000000' },
      { password: PW },
      { recoveryKey: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723' }
    ]
    const out = rust({
      dialogs: [file],
      steps: [{ op: 'transfer.pick' }, ...inputs.map((input) => ({ op: 'transfer.import', input: { token: '$token', ...input } })), { op: 'accounts.list' }]
    })
    const picked = await (async () => {
      state.dialogs = [file]
      return (await ts.dispatch('transfer.pick', {}, 'user')).data
    })()
    for (const [i, input] of inputs.entries()) {
      const r = await ts.dispatch('transfer.import', { token: picked.token, ...input }, 'user')
      expect(r.ok).toBe(false)
      expect(failed(out, i + 1)).toEqual(r.error)
    }
    // Nothing was replaced on the Rust side: it still holds its own (empty) data.
    expect(ok(out, inputs.length + 1)).toEqual([])
  })
})

describe('Rust exports, TypeScript imports', () => {
  const variants: { name: string; totp: boolean; recovery: boolean }[] = [
    { name: 'with the password', totp: false, recovery: false },
    { name: 'with the recovery key', totp: false, recovery: true },
    { name: 'with the password and a 2FA code', totp: true, recovery: false }
  ]
  for (const v of variants) {
    it(`moves the data ${v.name}`, async () => {
      const file = join(tmp.dir, `rust-export-${Math.random().toString(36).slice(2)}.kasboek`)
      const steps: object[] = [
        { op: 'accounts.create', input: { name: 'Checking', bank: 'Invented Bank', iban: 'BE68 5390 0754 7034', openingBalanceCents: 120000 } },
        { op: 'accounts.create', input: { name: 'Savings', bank: 'Invented Bank', iban: 'BE71 0961 2345 6769', openingBalanceCents: 500000 } },
        { op: 'transactions.create', input: { accountId: 1, bookingDate: '2026-11-01', amountCents: -1000, description: 'Groceries' } },
        { op: 'transactions.create', input: { accountId: 2, bookingDate: '2026-11-02', amountCents: -3500, description: 'Rent' } },
        { op: 'auth.newRecoveryKey', input: { current: RUST_PASSWORD } }
      ]
      if (v.totp) steps.push({ op: 'auth.totpBegin', input: {} }, { op: 'auth.totpEnable', input: { code: '$totp' } })
      steps.push({ op: 'transfer.export' })
      const out = rust({ dialogs: [file], steps })
      expect(ok(out, steps.length - 1)).toEqual({ file })
      const recoveryKey = ok(out, 4).recoveryKey as string
      const secret = v.totp ? (ok(out, 5).secret as string).replaceAll(' ', '') : null

      const ts = await tsApp()
      ts.db.close()
      state.unlocked = false
      state.db = null
      state.dialogs = []
      const picked = await ts.service.describeTransfer(file)
      expect(picked).toMatchObject({ fileName: file.split('/').pop(), kind: 'export', mode: 'password', twoFactor: v.totp, hasPassword: true, needsNewPassword: false })
      adopted.calls.length = 0
      const input = v.recovery
        ? { token: picked.token, recoveryKey }
        : { token: picked.token, password: RUST_PASSWORD, ...(secret ? { code: totpAt(secret, Date.parse(CLOCK) / 1000) } : {}) }
      const reset = await ts.service.importTransfer(input)
      expect(reset).toEqual([])
      const [next, master, vault, usedRecovery] = adopted.calls[0] as [AccountData, Buffer, Vault, boolean]
      expect(usedRecovery).toBe(v.recovery)
      expect(next).toMatchObject({ mode: 'password', twoFactor: v.totp })
      // The file's key opens the database that took the place of the old one.
      const imported = (await load()).openDatabase(join(ts.dir, 'kasboek.db'), vault.dbKey)
      expect(master.length).toBe(32)
      expect(moved(dump(imported))).toEqual(moved(out.dump))
      imported.close()
    })
  }
})
