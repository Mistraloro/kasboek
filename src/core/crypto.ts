/** Small, explicit crypto helpers. AES-256-GCM everywhere, with a label as associated data. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { argon2id } from 'hash-wasm'
import { AppError } from './errors'

const scryptAsync = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

export interface Sealed {
  iv: string
  /** Ciphertext followed by the 16-byte GCM tag, base64. */
  ct: string
}

export type Kdf =
  | { name: 'argon2id'; m: number; t: number; p: number; salt: string }
  | { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  | { name: 'hkdf'; salt: string }

/** A key slot: the master key, wrapped by a key derived from one credential. */
export interface Slot {
  kdf: Kdf
  sealed: Sealed
}

/**
 * Password hashing: Argon2id (RFC 9106), 128 MiB memory, 3 passes, 4 lanes. About 0.5 s on a laptop,
 * and expensive to attack with GPUs. Slots made by earlier versions with scrypt still open.
 */
export const PASSWORD_KDF = { m: 128 * 1024, t: 3, p: 4 }
let kdfOverride: { m: number; t: number; p: number } | null = null
/** For tests only. */
export function setPasswordKdfForTests(params: { m: number; t: number; p: number } | null): void {
  kdfOverride = params
}

export const random = (n: number): Buffer => randomBytes(n)

export function seal(key: Buffer, plain: Buffer, label: string): Sealed {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(label, 'utf8'))
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64') }
}

/** Returns null if the key is wrong or the data was changed. */
export function unseal(key: Buffer, sealed: Sealed, label: string): Buffer | null {
  try {
    const buf = Buffer.from(sealed.ct, 'base64')
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
    d.setAAD(Buffer.from(label, 'utf8'))
    d.setAuthTag(buf.subarray(buf.length - 16))
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()])
  } catch {
    return null
  }
}

export function hkdf(key: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(info, 'utf8'), 32))
}

async function deriveSlotKey(secret: string, kdf: Kdf): Promise<Buffer> {
  const salt = Buffer.from(kdf.salt, 'base64')
  if (kdf.name === 'hkdf') return hkdf(Buffer.from(secret, 'utf8'), salt, 'kasboek:slot')
  if (kdf.name === 'argon2id') {
    // Cap the cost so a crafted file can't make the app hang or run out of memory.
    if (kdf.m > 1024 * 1024 || kdf.t > 10 || kdf.p > 16 || kdf.m < 8 * kdf.p) throw new AppError('crypto.unsupported', 'These key settings are not supported.')
    const out = await argon2id({ password: secret.normalize('NFKC'), salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' })
    return Buffer.from(out)
  }
  if (kdf.N > 2 ** 20 || kdf.r > 16 || kdf.p > 4) {
    throw new AppError('crypto.unsupported', 'These key settings are not supported.')
  }
  return scryptAsync(secret.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 })
}

/** Wraps the master key with a password (scrypt) or a high-entropy secret such as the recovery key (HKDF). */
export async function makeSlot(master: Buffer, secret: string, kind: 'password' | 'recovery'): Promise<Slot> {
  const salt = randomBytes(16).toString('base64')
  const kdf: Kdf = kind === 'password' ? { name: 'argon2id', ...(kdfOverride ?? PASSWORD_KDF), salt } : { name: 'hkdf', salt }
  return { kdf, sealed: seal(await deriveSlotKey(secret, kdf), master, `kasboek:slot:${kind}`) }
}

/** True for slots made with an older, weaker setting; they are re-made after the next unlock. */
export function slotNeedsUpgrade(slot: Slot): boolean {
  return slot.kdf.name === 'scrypt'
}

export async function openSlot(slot: Slot, secret: string, kind: 'password' | 'recovery'): Promise<Buffer | null> {
  return unseal(await deriveSlotKey(secret, slot.kdf), slot.sealed, `kasboek:slot:${kind}`)
}

/* ---------- base32 (RFC 4648, no padding) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new AppError('crypto.base32', 'Invalid character in key.')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
