// Crypto parity: key slots (password Argon2id, recovery HKDF, legacy scrypt), the vault seal, TOTP and the base32 /
// recovery-key helpers, between src/core/crypto.ts + totp.ts + account.ts and kb-crypto (through kb-cli).
// All secrets are invented.
import { scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sealVault, openVault, type Vault } from '@core/account'
import { PASSWORD_KDF, base32Decode, base32Encode, makeSlot, openSlot, seal, setPasswordKdfForTests, slotNeedsUpgrade, type Slot } from '@core/crypto'
import { hotp, newRecoveryKey, normalizeRecoveryKey, otpauthUri, totpAt, verifyTotp } from '@core/totp'
import { CliError, cli } from './helpers'

const MASTER = Buffer.from('11'.repeat(32), 'hex')
// "ﬁ" (U+FB01), "ë" decomposed and a circled digit normalise differently under NFKC: both sides must agree.
const PASSWORD = 'pässﬁ Zoë ①'
const RECOVERY = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6723'

const rustOpen = (kind: 'password' | 'recovery', secret: string, slot: Slot): string | null => {
  try {
    return cli<{ master: string }>(['slot-open', kind, secret], slot).master
  } catch (e) {
    if (e instanceof CliError && e.code === 'slot.wrong_secret') return null
    throw e
  }
}
const errorCode = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as CliError).code
  }
  throw new Error('did not fail')
}

describe('password slot', () => {
  for (const [label, cost] of [
    ['default KDF (m=131072 t=3 p=4)', null],
    ['cheap KDF', { m: 64, t: 1, p: 1 }],
    ['several lanes', { m: 256, t: 2, p: 4 }]
  ] as const) {
    it(`TS makes it, Rust opens it (${label})`, async () => {
      setPasswordKdfForTests(cost)
      const slot = await makeSlot(MASTER, PASSWORD, 'password')
      setPasswordKdfForTests(null)
      expect(slot.kdf).toMatchObject({ name: 'argon2id', ...(cost ?? PASSWORD_KDF) })
      expect(rustOpen('password', PASSWORD, slot)).toBe(MASTER.toString('hex'))
      expect(rustOpen('password', 'pässfi Zoë 1', slot)).toBe(MASTER.toString('hex')) // already NFKC
      expect(rustOpen('password', PASSWORD + 'x', slot)).toBeNull()
      expect(rustOpen('recovery', PASSWORD, slot)).toBeNull() // the label is bound
    })

    it(`Rust makes it, TS opens it (${label})`, async () => {
      const c = cost ?? PASSWORD_KDF
      const slot = cli<Slot>(['slot-make', 'password', MASTER.toString('hex'), PASSWORD, String(c.m), String(c.t), String(c.p)])
      expect(slot.kdf).toMatchObject({ name: 'argon2id', ...c })
      expect(Object.keys(slot.kdf)).toEqual(['name', 'm', 't', 'p', 'salt'])
      expect((await openSlot(slot, PASSWORD, 'password'))?.toString('hex')).toBe(MASTER.toString('hex'))
      expect(await openSlot(slot, PASSWORD + 'x', 'password')).toBeNull()
    })
  }

  it('the default cost is what the plan says', () => {
    expect(PASSWORD_KDF).toEqual({ m: 131072, t: 3, p: 4 })
  })

  it('both sides refuse costs above the caps with the same code', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64')
    const sealed = seal(MASTER, MASTER, 'kasboek:slot:password')
    const refused: Slot['kdf'][] = [
      { name: 'argon2id', m: 1024 * 1024 + 1, t: 1, p: 1, salt },
      { name: 'argon2id', m: 64, t: 11, p: 1, salt },
      { name: 'argon2id', m: 2048, t: 1, p: 17, salt },
      { name: 'argon2id', m: 7, t: 1, p: 1, salt },
      { name: 'scrypt', N: 2 ** 21, r: 8, p: 1, salt },
      { name: 'scrypt', N: 1024, r: 17, p: 1, salt },
      { name: 'scrypt', N: 1024, r: 8, p: 5, salt }
    ]
    for (const kdf of refused) {
      const slot: Slot = { kdf, sealed }
      await expect(openSlot(slot, 'x', 'password')).rejects.toMatchObject({ code: 'crypto.unsupported' })
      expect(errorCode(() => cli(['slot-open', 'password', 'x'], slot))).toBe('crypto.unsupported')
    }
  })
})

describe('recovery slot', () => {
  it('TS makes it, Rust opens it (also with the key typed loosely)', async () => {
    const slot = await makeSlot(MASTER, normalizeRecoveryKey(RECOVERY), 'recovery')
    expect(slot.kdf.name).toBe('hkdf')
    expect(rustOpen('recovery', normalizeRecoveryKey(RECOVERY), slot)).toBe(MASTER.toString('hex'))
    expect(rustOpen('recovery', normalizeRecoveryKey('abcd efgh'), slot)).toBeNull()
  })

  it('Rust makes it, TS opens it', async () => {
    const slot = cli<Slot>(['slot-make', 'recovery', MASTER.toString('hex'), normalizeRecoveryKey(RECOVERY)])
    expect(Object.keys(slot.kdf)).toEqual(['name', 'salt'])
    expect((await openSlot(slot, normalizeRecoveryKey(RECOVERY), 'recovery'))?.toString('hex')).toBe(MASTER.toString('hex'))
    expect(await openSlot(slot, 'WRONG', 'recovery')).toBeNull()
  })

  it('normalisation and generation agree', () => {
    for (const input of ['abcd efgh ij', 'a1b0c8d9-ef', '', RECOVERY.toLowerCase(), '  ab-cd  ef gh  jk lm  ', 'ß-ü-é-ABC2']) {
      expect(cli(['recovery-normalize', input]).text).toBe(normalizeRecoveryKey(input))
    }
    const key = newRecoveryKey()
    expect(key).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)
    expect(cli(['recovery-normalize', key.toLowerCase()]).text).toBe(key)
  })
})

describe('legacy scrypt slot', () => {
  const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const make = (secret: string, N = 16384, r = 8, p = 1): Slot => ({
    kdf: { name: 'scrypt', N, r, p, salt: salt.toString('base64') },
    sealed: seal(scryptSync(secret.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }), MASTER, 'kasboek:slot:password')
  })

  it('opens in Rust, and is flagged for an upgrade on both sides', async () => {
    const slot = make(PASSWORD)
    expect(slotNeedsUpgrade(slot)).toBe(true)
    expect(rustOpen('password', PASSWORD, slot)).toBe(MASTER.toString('hex'))
    expect(rustOpen('password', 'nope', slot)).toBeNull()
    expect((await openSlot(slot, PASSWORD, 'password'))?.toString('hex')).toBe(MASTER.toString('hex'))
  })

  it('other parameters inside the caps work too', () => {
    const slot = make('abc', 1024, 4, 2)
    expect(rustOpen('password', 'abc', slot)).toBe(MASTER.toString('hex'))
  })
})

describe('vault seal', () => {
  const vault: Vault = { dbKey: 'ab'.repeat(32), totp: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', lastStep: -1 } }

  it('TS seals, Rust opens', () => {
    const sealed = sealVault(MASTER, vault)
    expect(cli(['vault-open', MASTER.toString('hex')], sealed)).toEqual(vault)
    expect(errorCode(() => cli(['vault-open', '22'.repeat(32)], sealed))).toBe('auth.corrupt')
  })

  it('Rust seals, TS opens (key order of the JSON is the app\'s)', () => {
    const sealed = cli(['vault-seal', MASTER.toString('hex')], vault)
    expect(openVault(MASTER, sealed)).toEqual(vault)
    expect(() => openVault(Buffer.alloc(32, 2), sealed)).toThrow(/damaged/)
    const without = cli(['vault-seal', MASTER.toString('hex')], { dbKey: 'cd'.repeat(32) })
    expect(openVault(MASTER, without)).toEqual({ dbKey: 'cd'.repeat(32) })
  })
})

describe('TOTP', () => {
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))
  // RFC 6238 appendix B, SHA-1, 8 digits.
  const RFC: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ]

  it('RFC 6238 test vectors, in Rust and in TS', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    for (const [t, code] of RFC) {
      expect(totpAt(RFC_SECRET, t, 8)).toBe(code)
      expect(cli(['totp', RFC_SECRET, String(t), '8']).code).toBe(code)
      expect(cli(['totp', RFC_SECRET, String(t)]).code).toBe(code.slice(2))
    }
  })

  it('codes agree for a spread of secrets and times', () => {
    let seedValue = 12345
    const next = (): number => (seedValue = (seedValue * 1103515245 + 12345) % 2 ** 31)
    for (let i = 0; i < 40; i++) {
      const secret = base32Encode(Buffer.from(Array.from({ length: 10 + (i % 20) }, () => next() & 255)))
      const t = next() % 4_000_000_000
      expect(cli(['totp', secret, String(t)]).code).toBe(totpAt(secret, t))
    }
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224')
  })

  it('verification: drift window, reuse, spaces, bad shapes', () => {
    const now = 1234567890
    const code = totpAt(RFC_SECRET, now)
    const step = Math.floor(now / 30)
    const rust = (c: string, last: number, at: number): number | null => cli(['totp-verify', RFC_SECRET, c, String(last), String(at)]).step
    for (const [c, last, at] of [
      [code, -1, now],
      [code, -1, now + 30],
      [code, -1, now - 30],
      [code, -1, now + 60],
      [code, step, now],
      [code, step - 1, now],
      [`${code.slice(0, 3)} ${code.slice(3)}`, -1, now],
      ['12345', -1, now],
      ['abcdef', -1, now],
      ['', -1, now]
    ] as [string, number, number][]) {
      expect(rust(c, last, at), `${c} last=${last} at=${at}`).toBe(verifyTotp(RFC_SECRET, c, last, at))
    }
  })

  it('otpauth URI is built like the app builds it (checked in TS; Rust has the same string in its unit test)', () => {
    expect(otpauthUri('ABC')).toBe('otpauth://totp/Kasboek%3AKasboek?secret=ABC&issuer=Kasboek&algorithm=SHA1&digits=6&period=30')
  })
})

describe('base32 and hex', () => {
  it('encode and decode agree, including sloppy input', () => {
    for (const hex of ['', '00', 'ff', '0123456789abcdef', 'deadbeefcafebabe0102', '11'.repeat(20), 'ab'.repeat(33)]) {
      const text = base32Encode(Buffer.from(hex, 'hex'))
      expect(cli(['base32-encode', hex]).text).toBe(text)
      expect(cli(['base32-decode', text]).hex).toBe(hex)
    }
    for (const sloppy of ['mzxw 6ytb-oi==', 'MZXW6YTBOI', 'mzxw6ytboi', 'MZ XW\t6Y-TB OI']) {
      expect(cli(['base32-decode', sloppy]).hex).toBe(base32Decode(sloppy).toString('hex'))
    }
    expect(errorCode(() => cli(['base32-decode', 'MZXW1']))).toBe('crypto.base32')
    expect(() => base32Decode('MZXW1')).toThrow(/Invalid character/)
  })
})
