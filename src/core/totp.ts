/** Time-based one-time passwords (RFC 6238): 6 digits, 30-second steps, HMAC-SHA1. Works with every authenticator app. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { base32Decode, base32Encode, random } from './crypto'

const STEP = 30
const DIGITS = 6

export function newTotpSecret(): string {
  return base32Encode(random(20))
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const offset = h[h.length - 1]! & 0x0f
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function totpAt(secretBase32: string, unixSeconds: number, digits = DIGITS): string {
  return hotp(base32Decode(secretBase32), Math.floor(unixSeconds / STEP), digits)
}

/**
 * Checks a code, allowing one step of clock drift either way.
 * Returns the matching time step, or null. A code at or before `lastStep` is rejected,
 * so a code can't be used twice.
 */
export function verifyTotp(secretBase32: string, code: string, lastStep: number, now = Date.now() / 1000): number | null {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const key = base32Decode(secretBase32)
  const current = Math.floor(now / STEP)
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(clean))) return step
  }
  return null
}

export function otpauthUri(secretBase32: string, account = 'Kasboek'): string {
  const label = encodeURIComponent(`Kasboek:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=Kasboek&algorithm=SHA1&digits=6&period=30`
}

/** Recovery key: 160 random bits as 8 groups of 4 base32 characters, e.g. `K7QJ-2M4X-…`. */
export function newRecoveryKey(): string {
  return base32Encode(random(20)).match(/.{4}/g)!.join('-')
}

export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-7]/g, '').match(/.{1,4}/g)?.join('-') ?? ''
}
