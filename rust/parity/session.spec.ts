// Session parity: the TypeScript session (src/main/session.ts on the real account.ts, account-store.ts and quarantine.ts,
// with Electron, the device check and the clock mocked) and the Rust crate kb-session (through its dev driver
// kb-session-cli) run the same scripts: setup, lock, unlock ok/fail with the throttle timing, recovery, 2FA with a fixed
// clock, password change, passwordless switch, erase and restore. Every status and error code is compared, and so are the
// resulting account.json structures (decrypted with the known keys; salts, IVs, ciphertexts and random keys masked).
// account.json of one side is also opened by the other. All secrets are invented.
// Needs: cargo build -p kb-session --features parity (the driver is rust/target/{release,debug}/kb-session-cli; the
// binary has required-features = ["parity"], so a plain `cargo build --workspace` does not make it).
// Rust-only hardening that the TypeScript lacks, on purpose, and what the spec does about it: a remembered-computer date
// more than 30 days ahead is refused, and the throttle never waits longer than its own delay when the last failure is dated
// in the future. Scripts here only use dates the app itself writes, except the one test that states the difference.
// A script may carry `lastAuth` (the prefs hint): only the Rust side uses it, to keep a device account sealed until the
// device check. The TypeScript opens the account at start; the results must be the same either way.
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openVault, type AccountData } from '@core/account'
import { openSlot, setPasswordKdfForTests } from '@core/crypto'
import { AppError } from '@core/errors'
import { totpAt } from '@core/totp'
import { contract } from '@shared/contract'
import { checkPassword } from '@shared/password'
import { tempDir } from './helpers'

const SEAL_KEY = Buffer.from('42'.repeat(32), 'hex')
const T0 = 1_790_000_000_000
const KDF = { m: 64, t: 1, p: 1 }
const PW = 'violet-Harbor-83-lantern'
const PW2 = 'copper-Meadow-41-ribbon'

const mock = vi.hoisted(() => ({
  dir: '',
  sealAvailable: true,
  device: { kind: null as string | null, verify: true },
  seal: null as null | { encrypt: (s: string) => Buffer; decrypt: (b: Buffer) => string }
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 },
  app: { getPath: () => mock.dir, isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => mock.sealAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (s: string) => mock.seal!.encrypt(s),
    decryptStringAsync: async (b: Buffer) => ({ result: mock.seal!.decrypt(b) })
  }
}))
vi.mock('../../src/main/graphics', () => ({ startupLog: vi.fn() }))
vi.mock('../../src/main/prefs', () => ({ getPrefs: () => ({}) }))
vi.mock('../../src/main/security/device-auth', () => ({
  deviceAuthKind: async () => mock.device.kind,
  peekDeviceAuthKind: () => mock.device.kind,
  releaseDeviceCheck: vi.fn(),
  verifyDeviceUser: async () => mock.device.verify
}))

// The test seal both sides share: AES-256-GCM, blob = iv(12) || ciphertext || tag(16), AAD "kasboek:fileseal".
const seal = {
  encrypt(s: string): Buffer {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', SEAL_KEY, iv)
    c.setAAD(Buffer.from('kasboek:fileseal'))
    return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()])
  },
  decrypt(b: Buffer): string {
    const d = createDecipheriv('aes-256-gcm', SEAL_KEY, b.subarray(0, 12))
    d.setAAD(Buffer.from('kasboek:fileseal'))
    d.setAuthTag(b.subarray(b.length - 16))
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')
  }
}
mock.seal = seal

type Step = { op: string; input?: unknown } | { now: number } | { advance: number } | { device: { kind: string | null; verify: boolean } } | { reload: true; lastAuth?: LastAuth }
interface LastAuth {
  mode: 'password' | 'device'
  twoFactor: boolean
  rememberedUntil: string | null
  attempts: { failed: number; lastFailedAt: string | null }
}
interface Script {
  steps: Step[]
  device?: { kind: string | null; verify: boolean }
  sealAvailable?: boolean
  now?: number
  lastAuth?: LastAuth
  /** Values from an earlier run in the same folder (cross-open). */
  vars?: { recovery?: string; totpSecret?: string }
}
interface StepResult {
  result: { ok: true; data: any } | { ok: false; error: { code: string; message: string } }
  unlocked: boolean
}

const tmp = tempDir('kb-session-')
afterAll(() => tmp.remove())
let counter = 0
const freshDir = (): string => {
  const dir = join(tmp.dir, `run${counter++}`)
  execFileSync('mkdir', ['-p', dir])
  return dir
}

/* ---------- TypeScript side ---------- */

async function runTs(dir: string, script: Script): Promise<StepResult[]> {
  vi.resetModules()
  mock.dir = dir
  mock.sealAvailable = script.sealAvailable ?? true
  mock.device = { kind: script.device?.kind ?? null, verify: script.device?.verify ?? true }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(script.now ?? T0)
  const crypto = await import('@core/crypto')
  crypto.setPasswordKdfForTests(KDF)
  const session = await import('../../src/main/session')
  await session.startSession()
  let recovery = script.vars?.recovery ?? ''
  let secret = script.vars?.totpSecret ?? ''
  const resolveVars = (v: any): any => {
    if (v === '$recovery') return recovery
    if (v === '$recoveryLoose') return recovery.toLowerCase().replace(/-/g, ' ')
    if (typeof v === 'string' && (v === '$totp' || v.startsWith('$totp:'))) return totpAt(secret, Date.now() / 1000 + Number(v.slice(6) || 0))
    if (Array.isArray(v)) return v.map(resolveVars)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveVars(x)]))
    return v
  }
  const out: StepResult[] = []
  for (const step of script.steps) {
    if ('now' in step) vi.setSystemTime(step.now)
    else if ('advance' in step) vi.setSystemTime(Date.now() + step.advance)
    else if ('device' in step) mock.device = { ...step.device }
    else if ('reload' in step) await session.initSession()
    else {
      const name = step.op as keyof typeof contract
      let result: StepResult['result']
      try {
        const parsed = contract[name].input.safeParse(resolveVars(step.input ?? {}))
        if (!parsed.success) throw new AppError('op.invalid_input', 'invalid')
        const input = parsed.data as any
        let data: any
        switch (name) {
          case 'auth.status': data = await session.status(); break
          case 'auth.setup': data = await session.setup(input.mode, input.mode === 'password' ? input.password : undefined); recovery = data.recoveryKey; break
          case 'auth.unlock': await session.unlock(input); data = await session.status(); break
          case 'auth.unlockRecovery': await session.unlockRecovery(input.recoveryKey); data = await session.status(); break
          case 'auth.lock': session.lock('user'); data = await session.status(); break
          case 'auth.erase': await session.erase(); data = await session.status(); break
          case 'auth.restoreErased': await session.restoreErasedData(input.name); data = await session.status(); break
          case 'auth.changePassword': await session.changePassword(input.current, input.next); data = await session.status(); break
          case 'auth.usePasswordless': await session.switchToPasswordless(input.current); data = await session.status(); break
          case 'auth.newRecoveryKey': data = { recoveryKey: await session.newRecoveryKey(input.current) }; recovery = data.recoveryKey; break
          case 'auth.forgetComputer': await session.forgetThisComputer(); data = await session.status(); break
          case 'auth.totpBegin': data = await session.totpBegin(); secret = data.secret.replace(/ /g, ''); break
          case 'auth.totpEnable': await session.totpEnable(input.code); data = await session.status(); break
          case 'auth.totpDisable': await session.totpDisable(input.code); data = await session.status(); break
          default: throw new Error(`no TypeScript runner for ${name}`)
        }
        result = { ok: true, data }
      } catch (e) {
        // What runOp answers for an error that is not an AppError.
        // (The module registry is reset per run, so the class is told by its name.)
        result = e instanceof Error && e.name === 'AppError' ? { ok: false, error: { code: (e as AppError).code, message: e.message } } : { ok: false, error: { code: 'op.failed', message: 'Something went wrong. Details are in the log.' } }
      }
      out.push({ result, unlocked: session.isUnlocked() })
    }
  }
  session.lock('user', true)
  vi.useRealTimers()
  return out
}

/* ---------- Rust side ---------- */

const exe = process.platform === 'win32' ? '.exe' : ''
const candidates = ['release', 'debug'].map((p) => resolve(import.meta.dirname, `../target/${p}/kb-session-cli${exe}`))
const CLI = process.env.KB_SESSION_CLI ?? candidates.find((c) => existsSync(c)) ?? candidates[0]!

function runRust(dir: string, script: Script): StepResult[] {
  const input = {
    dir,
    now: script.now ?? T0,
    kdf: KDF,
    sealKey: script.sealAvailable === false ? null : SEAL_KEY.toString('hex'),
    seed: 11,
    device: script.device ?? { kind: null, verify: true },
    vars: script.vars,
    lastAuth: script.lastAuth,
    steps: script.steps
  }
  const text = execFileSync(CLI, { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return (JSON.parse(text) as { result: any; unlocked: boolean }[]).map((r) => ({ result: r.result.ok ? { ok: true, data: r.result.data } : { ok: false, error: r.result.error }, unlocked: r.unlocked }))
}

/* ---------- Comparing ---------- */

const RECOVERY_RE = /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/
const SECRET_RE = /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/

/** Random values are checked for their shape and masked. */
function mask(results: StepResult[]): unknown {
  return results.map((r) => {
    // The texts of invalid input come from zod on one side and from hand-written checks on the other: the code is compared.
    if (!r.result.ok) return { ...r, result: { ok: false, error: r.result.error.code === 'op.invalid_input' ? { code: 'op.invalid_input' } : r.result.error } }
    const data = { ...r.result.data }
    if ('recoveryKey' in data) {
      expect(data.recoveryKey).toMatch(RECOVERY_RE)
      data.recoveryKey = '<recovery key>'
    }
    if ('secret' in data) {
      expect(data.secret).toMatch(SECRET_RE)
      expect(data.uri).toBe(`otpauth://totp/Kasboek%3AKasboek?secret=${data.secret.replace(/ /g, '')}&issuer=Kasboek&algorithm=SHA1&digits=6&period=30`)
      data.secret = '<secret>'
      data.uri = '<uri>'
      data.qrSvg = '<qr>'
    }
    return { ...r, result: { ok: true, data } }
  })
}

function readAccount(dir: string): AccountData | null {
  const file = join(dir, 'account.json')
  if (!existsSync(file)) return null
  const f = JSON.parse(readFileSync(file, 'utf8'))
  expect(Object.keys(f)).toEqual(['format', 'version', 'seal', 'data'])
  const raw = Buffer.from(f.data, 'base64')
  return JSON.parse(f.seal === 'os' ? seal.decrypt(raw) : raw.toString('utf8')) as AccountData
}

/** The account with everything random masked, and the vault opened with the known password or recovery key. */
async function accountShape(dir: string, secret: string): Promise<unknown> {
  const account = readAccount(dir)
  if (!account) return null
  const copy = JSON.parse(JSON.stringify(account)) as any
  const masterKey = account.slots.password ? await openSlot(account.slots.password, secret, 'password') : Buffer.from(account.slots.device!, 'base64')
  expect(masterKey).not.toBeNull()
  const vault = openVault(masterKey!, account.vault)
  expect(vault.dbKey).toMatch(/^[0-9a-f]{64}$/)
  for (const slot of [copy.slots.password, copy.slots.recovery]) {
    if (!slot) continue
    slot.kdf.salt = '<salt>'
    slot.sealed = { iv: '<iv>', ct: '<ct>' }
  }
  if (copy.slots.device) copy.slots.device = '<master>'
  copy.vault = { iv: '<iv>', ct: '<ct>' }
  if (copy.remember2fa) copy.remember2fa.mac = '<mac>'
  return { account: copy, vault: { ...vault, dbKey: '<db key>', ...(vault.totp ? { totp: { ...vault.totp, secret: '<secret>' } } : {}) }, vaultKeys: Object.keys(vault) }
}

async function both(script: Script, secret = PW): Promise<{ ts: StepResult[]; rust: StepResult[]; tsDir: string; rustDir: string }> {
  const tsDir = freshDir()
  const rustDir = freshDir()
  const ts = await runTs(tsDir, script)
  const rust = runRust(rustDir, script)
  expect(mask(rust)).toEqual(mask(ts))
  expect(await accountShape(rustDir, secret)).toEqual(await accountShape(tsDir, secret))
  return { ts, rust, tsDir, rustDir }
}

const op = (name: string, input: unknown = {}): Step => ({ op: name, input })
const SETUP = op('auth.setup', { mode: 'password', password: PW })
const bad = op('auth.unlock', { password: 'a wrong password' })

beforeAll(() => setPasswordKdfForTests(KDF))

describe('the same script on the TypeScript session and kb-session', () => {
  it('setup, lock, unlock with a right and wrong password, status in between', async () => {
    await both({ steps: [op('auth.status'), SETUP, op('auth.status'), op('auth.lock'), op('auth.status'), bad, op('auth.unlock', { password: PW }), op('auth.status'), op('auth.setup', { mode: 'password', password: PW })] })
  })

  it('refuses invalid inputs with the same codes', async () => {
    await both({
      steps: [
        op('auth.status', { x: 1 }),
        op('auth.setup', { mode: 'password', password: 'short' }),
        op('auth.setup', { mode: 'device', password: PW }),
        op('auth.setup', { mode: 'password' }),
        SETUP,
        op('auth.lock'),
        op('auth.unlock', { password: 'x'.repeat(257) }),
        op('auth.unlock', { code: '1234567890123' }),
        op('auth.unlock', { remember: 'yes' }),
        op('auth.unlockRecovery', { recoveryKey: 'short' }),
        op('auth.erase', { confirm: 'erase' }),
        op('auth.restoreErased', { name: '12' }),
        op('auth.totpEnable', { code: '12345' }),
        op('auth.changePassword', { next: 'weak' }),
        op('auth.unlock', {})
      ]
    })
  })

  it('operations on a locked or missing account', async () => {
    await both({ steps: [op('auth.unlock', { password: PW }), op('auth.unlockRecovery', { recoveryKey: 'AAAA-BBBB-CCCC-DDDD' }), op('auth.totpBegin'), op('auth.forgetComputer'), op('auth.changePassword', { current: PW, next: PW2 }), SETUP, op('auth.lock'), op('auth.totpBegin'), op('auth.totpDisable', { code: '123456' }), op('auth.newRecoveryKey', {}), op('auth.forgetComputer')] })
  })

  it('throttles after five wrong tries: 30 s, then doubling to 15 minutes, with the injected clock', async () => {
    const steps: Step[] = [SETUP, op('auth.lock'), bad, bad, bad, bad, bad, op('auth.status'), op('auth.unlock', { password: PW }), { advance: 29_001 }, op('auth.status'), { advance: 999 }, op('auth.status')]
    for (const wait of [30, 60, 120, 240, 480, 900, 900]) steps.push(bad, op('auth.status'), op('auth.unlock', { password: PW }), { advance: wait * 1000 - 1 }, op('auth.status'), { advance: 1 })
    steps.push(op('auth.unlock', { password: PW }), op('auth.status'))
    await both({ steps })
  })

  it('recovery key: unlock, recovered flag, new password without the old one', async () => {
    await both({
      steps: [SETUP, op('auth.lock'), op('auth.unlockRecovery', { recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH' }), op('auth.unlockRecovery', { recoveryKey: '$recoveryLoose' }), op('auth.status'), op('auth.changePassword', { next: PW2 }), op('auth.status'), op('auth.lock'), op('auth.unlock', { password: PW }), op('auth.unlock', { password: PW2 }), op('auth.status')]
    }, PW2)
  })

  it('changing the password, a new recovery key, and the mistakes counted on the way', async () => {
    await both({
      steps: [SETUP, op('auth.changePassword', { current: 'not the password', next: PW2 }), op('auth.status'), op('auth.changePassword', { current: PW, next: PW2 }), op('auth.newRecoveryKey', { current: PW }), op('auth.newRecoveryKey', { current: PW2 }), op('auth.lock'), op('auth.unlockRecovery', { recoveryKey: '$recovery' }), op('auth.status'), op('auth.newRecoveryKey', {}), op('auth.lock'), op('auth.unlock', { password: PW2 })]
    }, PW2)
  })

  it('2FA: enable with a fixed clock, unlock rules, remember for 30 days, forget, disable', async () => {
    await both({
      steps: [
        SETUP,
        op('auth.totpEnable', { code: '123456' }),
        op('auth.totpBegin'),
        op('auth.totpEnable', { code: '000000' }),
        op('auth.totpEnable', { code: '$totp' }),
        op('auth.status'),
        op('auth.lock'),
        op('auth.status'),
        op('auth.unlock', { password: PW }),
        op('auth.unlock', { password: PW, code: '000000' }),
        op('auth.unlock', { password: PW, code: '$totp' }), // the step of the enabling code: refused as a re-use
        { advance: 90_000 },
        op('auth.unlock', { password: PW, code: '$totp', remember: true }),
        op('auth.status'),
        op('auth.lock'),
        op('auth.status'),
        op('auth.unlock', { password: PW }),
        op('auth.lock'),
        op('auth.forgetComputer'),
        op('auth.unlock', { password: PW, code: '$totp' }),
        op('auth.forgetComputer'),
        op('auth.status'),
        op('auth.lock'),
        { advance: 31 * 86_400_000 },
        op('auth.unlock', { password: PW }),
        op('auth.totpDisable', { code: '000000' }),
        op('auth.unlockRecovery', { recoveryKey: '$recovery' }),
        op('auth.totpDisable', { code: '' }),
        op('auth.status')
      ]
    })
  })

  it('2FA code within one step of drift is accepted, two steps is not', async () => {
    await both({ steps: [SETUP, op('auth.totpBegin'), op('auth.totpEnable', { code: '$totp:-30' }), op('auth.lock'), { advance: 600_000 }, op('auth.unlock', { password: PW, code: '$totp:-90' }), op('auth.unlock', { password: PW, code: '$totp:30' })] })
  })

  it('passwordless: switch, device prompt outcomes, unlock, back to a password', async () => {
    const touch = { kind: 'touch-id', verify: true }
    await both({
      device: touch,
      steps: [
        SETUP,
        op('auth.usePasswordless', { current: 'wrong wrong wrong' }),
        { device: { kind: 'touch-id', verify: false } },
        op('auth.usePasswordless', { current: PW }),
        { device: { kind: null, verify: true } },
        op('auth.usePasswordless', { current: PW }),
        { device: touch },
        op('auth.usePasswordless', { current: PW }),
        op('auth.lock'),
        op('auth.status'),
        { device: { kind: 'touch-id', verify: false } },
        op('auth.unlock', {}),
        { device: touch },
        op('auth.unlock', {}),
        op('auth.status'),
        op('auth.totpBegin'),
        op('auth.totpEnable', { code: '$totp' }),
        op('auth.lock'),
        op('auth.unlock', {}),
        { advance: 60_000 },
        op('auth.unlock', { code: '$totp' }),
        op('auth.changePassword', { next: PW2 }),
        op('auth.status')
      ]
    }, PW2)
  })

  it('passwordless setup, erase with the device check, restore, and the other_device case', async () => {
    const touch = { kind: 'touch-id', verify: true }
    await both({
      device: touch,
      steps: [op('auth.setup', { mode: 'device' }), op('auth.lock'), { device: { kind: 'touch-id', verify: false } }, op('auth.erase', { confirm: 'ERASE' }), op('auth.status'), { device: touch }, op('auth.erase', { confirm: 'ERASE' }), op('auth.status'), op('auth.setup', { mode: 'device' }), op('auth.erase', { confirm: 'ERASE' })]
    }, '')
  })

  it('erase and restore: names, same-millisecond entries, blocked restore, purge after 30 days', async () => {
    const first = String(T0)
    await both({
      steps: [
        SETUP,
        op('auth.erase', { confirm: 'ERASE' }),
        op('auth.status'),
        op('auth.setup', { mode: 'password', password: PW2 }),
        op('auth.restoreErased', { name: first }),
        op('auth.erase', { confirm: 'ERASE' }),
        op('auth.status'),
        op('auth.restoreErased', { name: '1234567890' }),
        op('auth.restoreErased', { name: String(T0 + 1) }),
        op('auth.status'),
        op('auth.unlock', { password: PW2 }),
        op('auth.lock'),
        op('auth.erase', { confirm: 'ERASE' }),
        { advance: 30 * 86_400_000 },
        { reload: true },
        op('auth.status')
      ]
    }, PW2)
  })

  it('no OS seal: account.json is written with seal "none" and passwordless is refused', async () => {
    await both({ sealAvailable: false, device: { kind: 'touch-id', verify: true }, steps: [SETUP, op('auth.status'), op('auth.usePasswordless', { current: PW }), op('auth.lock'), op('auth.unlock', { password: PW })] })
  })
})

const deviceHint = (failed = 0): LastAuth => ({ mode: 'device', twoFactor: true, rememberedUntil: null, attempts: { failed, lastFailedAt: null } })

describe('the Rust session starting from a lastAuth hint answers like the TypeScript', () => {
  const touch = { kind: 'touch-id', verify: true }
  const wrongKey = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH'

  it('passwordless with 2FA: cancelled prompt, wrong codes, throttle, wrong and right recovery key', async () => {
    const steps: Step[] = [op('auth.setup', { mode: 'device' }), op('auth.totpBegin'), op('auth.totpEnable', { code: '$totp' }), op('auth.lock'), { reload: true, lastAuth: deviceHint() }, op('auth.status'), { device: { kind: 'touch-id', verify: false } }, op('auth.unlock', { code: '123456' }), { device: touch }]
    for (let i = 0; i < 5; i++) steps.push(op('auth.unlock', { code: '000000' }))
    steps.push(op('auth.status'), op('auth.unlock', { code: '000000' }), op('auth.unlockRecovery', { recoveryKey: '$recovery' }), op('auth.status'), { advance: 31_000 }, op('auth.unlockRecovery', { recoveryKey: wrongKey }), op('auth.status'), { advance: 61_000 }, op('auth.unlockRecovery', { recoveryKey: '$recoveryLoose' }), op('auth.status'), op('auth.lock'), { advance: 60_000 }, op('auth.unlock', { code: '$totp' }), op('auth.status'))
    await both({ device: touch, lastAuth: deviceHint(), steps }, '')
  })

  it('a stale device hint on a password account: the password still unlocks, with and without a device', async () => {
    for (const device of [touch, { kind: null, verify: true }]) {
      await both({ device, lastAuth: deviceHint(), steps: [SETUP, op('auth.lock'), { reload: true, lastAuth: deviceHint() }, bad, op('auth.unlock', { password: PW }), op('auth.status')] })
    }
  })

  it('a hint that says "password" on a passwordless account is not trusted either', async () => {
    await both({ device: touch, steps: [op('auth.setup', { mode: 'device' }), op('auth.lock'), { reload: true, lastAuth: { ...deviceHint(), mode: 'password', twoFactor: false } }, op('auth.unlock', {}), op('auth.status')] }, '')
  })
})

describe('hardening only the Rust session has', () => {
  it('a last failure dated in the future never waits longer than the delay (the TypeScript waits for the whole gap)', async () => {
    const year = 365 * 86_400_000
    const steps: Step[] = [SETUP, op('auth.lock'), bad, bad, bad, bad, bad, { now: T0 - year }, op('auth.status')]
    const ts = await runTs(freshDir(), { steps })
    const rust = runRust(freshDir(), { steps })
    expect((ts.at(-1)!.result as any).data.throttleSeconds).toBe(year / 1000 + 30)
    expect((rust.at(-1)!.result as any).data.throttleSeconds).toBe(30)
    // Everything before the clock jump is the same.
    expect(mask(rust.slice(0, -1))).toEqual(mask(ts.slice(0, -1)))
  })
})

describe('password rules', () => {
  it('give the same verdict, issues, strength and bits as checkPassword', () => {
    const list = [
      '', 'a', 'short1A!', PW, PW2, 'alllowercaseletters', 'ALLUPPERCASELETTERS', '123456789012', 'Welkom2026!xx', 'P@ssw0rd123456', 'aaaaBBBB1111!!', 'Kasboek-Secret-77x',
      'abcd-Efgh-Qwerty-1', 'Passw0rd!Passw0rd!', 'summersummer-A1', 'correct horse battery staple', 'Correct-Horse-Battery-9', 'zoë-ﬁsh-Ünïcode-77-ÀÉ', '日本語のパスワード1234',
      'abababab-Zz9', 'xyzXYZ123!@#abc', 'Tr0ub4dor&3', 'qwertyuiop-A1-b2', 'azerty-Mot2passe-9', 'The-quick-brown-fox-12', '          x1A', 'line\nbreak-Aa1-xyz-pqrs', 'dddd-Eeee-77-lantern', 'ab12ab12ab12-Qq!', 'Hello-World-2026-zz', 'bank-Geld-argent-77-QQ', 'monkey-Dragon-81-xylophone'
    ]
    const rust = JSON.parse(execFileSync(CLI, { input: JSON.stringify({ checkPassword: list }), encoding: 'utf8' })) as any[]
    list.forEach((p, i) => {
      const ts = checkPassword(p)
      expect(rust[i], JSON.stringify(p)).toEqual({ ok: ts.ok, issues: ts.issues, strength: ts.strength, bits: ts.bits, classes: ts.classes })
    })
  })
})

describe('cross-open: account.json written by one side opens on the other', () => {
  const touch = { kind: 'touch-id', verify: true }
  const rich: Step[] = [SETUP, op('auth.totpBegin'), op('auth.totpEnable', { code: '$totp' }), { advance: 90_000 }, op('auth.lock'), op('auth.unlock', { password: PW, code: '$totp', remember: true }), op('auth.lock')]

  it('TypeScript writes (password, 2FA, remembered computer), Rust unlocks with password, with the remembered code skipped, and with recovery', async () => {
    const dir = freshDir()
    const first = await runTs(dir, { steps: rich })
    const secret = (first[1]!.result as any).data.secret.replace(/ /g, '')
    const recovery = (first[0]!.result as any).data.recoveryKey
    const after = runRust(dir, { now: T0 + 90_000, vars: { recovery, totpSecret: secret }, steps: [op('auth.status'), op('auth.unlock', { password: PW }), op('auth.lock'), op('auth.unlockRecovery', { recoveryKey: '$recoveryLoose' }), op('auth.status')] })
    expect(after.map((r) => r.result.ok)).toEqual([true, true, true, true, true])
    expect((after[0]!.result as any).data.rememberedUntil).toBe(new Date(T0 + 90_000 + 30 * 86_400_000).toISOString())
    expect((after[4]!.result as any).data.recovered).toBe(true)
  })

  it('Rust writes (same), TypeScript unlocks', async () => {
    const dir = freshDir()
    const first = runRust(dir, { steps: rich })
    const secret = (first[1]!.result as any).data.secret.replace(/ /g, '')
    const recovery = (first[0]!.result as any).data.recoveryKey
    const after = await runTs(dir, { now: T0 + 90_000, vars: { recovery, totpSecret: secret }, steps: [op('auth.status'), op('auth.unlock', { password: PW }), op('auth.lock'), op('auth.unlockRecovery', { recoveryKey: '$recoveryLoose' }), op('auth.status')] })
    expect(after.map((r) => r.result.ok)).toEqual([true, true, true, true, true])
    expect((after[0]!.result as any).data.rememberedUntil).toBe(new Date(T0 + 90_000 + 30 * 86_400_000).toISOString())
  })

  it('passwordless account: each side unlocks the other\'s file, and a wrong seal key is other_device', async () => {
    for (const [writer, reader] of [['ts', 'rust'], ['rust', 'ts']] as const) {
      const dir = freshDir()
      const script: Script = { device: touch, steps: [op('auth.setup', { mode: 'device' }), op('auth.lock')] }
      if (writer === 'ts') await runTs(dir, script)
      else runRust(dir, script)
      const read: Script = { device: touch, steps: [op('auth.status'), op('auth.unlock', {}), op('auth.status')] }
      const out = reader === 'ts' ? await runTs(dir, read) : runRust(dir, read)
      expect(out.map((r) => r.result.ok)).toEqual([true, true, true])
      expect((out[2]!.result as any).data.state).toBe('unlocked')
    }
  })

  it('the legacy keystore.json is migrated by both sides at setup', async () => {
    for (const side of ['ts', 'rust'] as const) {
      const dir = freshDir()
      // A database made by the TypeScript core with a known key, plus the Phase 1 key file.
      const { openDatabase } = await import('@core/database')
      const key = 'cd'.repeat(32)
      openDatabase(join(dir, 'kasboek.db'), key).close()
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(dir, 'keystore.json'), JSON.stringify({ dbKey: `plain:${Buffer.from(key).toString('base64')}` }))
      const script: Script = { steps: [op('auth.status'), SETUP, op('auth.lock'), op('auth.unlock', { password: PW })] }
      const out = side === 'ts' ? await runTs(dir, script) : runRust(dir, script)
      expect((out[0]!.result as any).data.legacyData).toBe(true)
      expect(out.slice(1).every((r) => r.result.ok)).toBe(true)
      expect(existsSync(join(dir, 'keystore.json'))).toBe(false)
      const account = readAccount(dir)!
      expect(openVault((await openSlot(account.slots.password!, PW, 'password'))!, account.vault).dbKey).toBe(key)
    }
  })
})
