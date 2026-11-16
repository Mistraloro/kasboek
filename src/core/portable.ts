/**
 * Kasboek's file formats, read without Node.js: only WebCrypto (crypto.subtle), DecompressionStream
 * and hash-wasm (Argon2id, scrypt). This is the code a mobile app (in a WebView, React Native with a
 * WebCrypto polyfill, or a browser) uses to open what the desktop app writes:
 *
 *   - an export, backup or sync snapshot (.kasboek, "KASBOEK2"): password (+ 2FA code) or recovery key
 *     → master key → vault (database key, 2FA secret) + the encrypted database file;
 *   - the database itself: SQLite3 Multiple Ciphers, cipher "chacha20", key = vault.dbKey (hex).
 *     sqlite3mc has native builds for Android and iOS and a WASM build;
 *   - sync change and state files (.kbsync, "KBSYNC1"): AES-256-GCM with the sync key, which is in the
 *     database's `secrets` table (key "syncKey", hex).
 *
 * tests/portable.test.ts checks that it opens files made by the desktop code. Nothing here writes.
 */
import { argon2id, scrypt } from 'hash-wasm'

const enc = new TextEncoder()
const dec = new TextDecoder()

export class PortableError extends Error {}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0)
const startsWith = (b: Uint8Array, magic: string): boolean => dec.decode(b.subarray(0, magic.length)) === magic

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new PortableError('WebCrypto is not available.')
  return s
}
// TypeScript's DOM types want an ArrayBuffer-backed view; copying keeps every caller simple.
// (A Node Buffer's own slice() is a view into a larger shared block; this always copies.)
const buf = (b: Uint8Array): ArrayBuffer => Uint8Array.prototype.slice.call(b).buffer as ArrayBuffer

/** AES-256-GCM; `data` is ciphertext followed by the 16-byte tag. Null if the key is wrong or data changed. */
export async function aesGcmOpen(key: Uint8Array, iv: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  try {
    const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad), tagLength: 128 }, k, buf(data)))
  } catch {
    return null
  }
}

export async function hkdfSha256(key: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(enc.encode(info)) }, k, 256))
}

/* ---------- Key slots ---------- */

type Kdf =
  | { name: 'argon2id'; m: number; t: number; p: number; salt: string }
  | { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  | { name: 'hkdf'; salt: string }
interface Slot {
  kdf: Kdf
  sealed: { iv: string; ct: string }
}

async function slotKey(secret: string, kdf: Kdf): Promise<Uint8Array> {
  const salt = b64(kdf.salt)
  if (kdf.name === 'hkdf') return hkdfSha256(enc.encode(secret), salt, 'kasboek:slot')
  if (kdf.name === 'argon2id') {
    if (kdf.m > 1024 * 1024 || kdf.t > 10 || kdf.p > 16 || kdf.m < 8 * kdf.p) throw new PortableError('These key settings are not supported.')
    return argon2id({ password: secret.normalize('NFKC'), salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' })
  }
  if (kdf.N > 2 ** 20 || kdf.r > 16 || kdf.p > 4) throw new PortableError('These key settings are not supported.')
  return scrypt({ password: secret.normalize('NFKC'), salt, costFactor: kdf.N, blockSize: kdf.r, parallelism: kdf.p, hashLength: 32, outputType: 'binary' })
}

async function openSlot(slot: Slot, secret: string, kind: 'password' | 'recovery'): Promise<Uint8Array | null> {
  return aesGcmOpen(await slotKey(secret, slot.kdf), b64(slot.sealed.iv), b64(slot.sealed.ct), enc.encode(`kasboek:slot:${kind}`))
}

export const normalizeRecoveryKey = (input: string): string => input.toUpperCase().replace(/[^A-Z2-7]/g, '').match(/.{1,4}/g)?.join('-') ?? ''

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------- */

function base32Decode(text: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = A.indexOf(ch)
    if (i < 0) throw new PortableError('Invalid character in key.')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

export async function totpAt(secretBase32: string, step: number): Promise<string> {
  const k = await subtle().importKey('raw', buf(base32Decode(secretBase32)), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(step))
  const h = new Uint8Array(await subtle().sign('HMAC', k, msg))
  const o = h[19]! & 15
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!
  return String(n % 1e6).padStart(6, '0')
}

/** The matching time step (now, or one step either side), or null. */
export async function verifyTotp(secretBase32: string, code: string, now = Date.now() / 1000): Promise<number | null> {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const current = Math.floor(now / 30)
  for (const step of [current, current - 1, current + 1]) if ((await totpAt(secretBase32, step)) === clean) return step
  return null
}

/* ---------- Export / backup / snapshot (.kasboek) ---------- */

export interface PortableVault {
  /** The database key, hex: `PRAGMA cipher='chacha20'; PRAGMA hexkey='…'` in SQLite3 Multiple Ciphers. */
  dbKey: string
  totp?: { secret: string; lastStep: number }
}

export interface PortableTransfer {
  header: { format: 2; kind: string; createdAt: string; appVersion: string; schemaVersion: number; mode: string; twoFactor: boolean }
  master: Uint8Array
  vault: PortableVault
  /** The database file, still encrypted with vault.dbKey. */
  dbFile: Uint8Array
  usedRecovery: boolean
}

export async function openTransfer(file: Uint8Array, credential: { password: string; code?: string } | { recoveryKey: string }): Promise<PortableTransfer> {
  const MAGIC = 'KASBOEK2'
  if (!startsWith(file, MAGIC) || file.length < 12) throw new PortableError('This file is not a Kasboek export.')
  const headerLen = u32(file, 8)
  const end = 12 + headerLen
  if (headerLen === 0 || headerLen > 64 * 1024 || file.length < end + 16) throw new PortableError('This file is damaged.')
  const header = JSON.parse(dec.decode(file.subarray(12, end))) as PortableTransfer['header'] & { slots: { password?: Slot; recovery: Slot }; salt: string; iv: string }
  if (header.format !== 2) throw new PortableError('This file was made by a newer version of Kasboek.')

  const usedRecovery = 'recoveryKey' in credential
  const master = usedRecovery
    ? await openSlot(header.slots.recovery, normalizeRecoveryKey(credential.recoveryKey), 'recovery')
    : header.slots.password
      ? await openSlot(header.slots.password, credential.password, 'password')
      : null
  if (!master) throw new PortableError('The login details don’t match this file.')

  const key = await hkdfSha256(master, b64(header.salt), 'kasboek:file:v2')
  const plain = await aesGcmOpen(key, b64(header.iv), file.subarray(end), file.subarray(0, end))
  if (!plain) throw new PortableError('This file is damaged or has been changed.')
  const vaultLen = u32(plain, 0)
  const vault = JSON.parse(dec.decode(plain.subarray(4, 4 + vaultLen))) as PortableVault
  if (!usedRecovery && header.twoFactor) {
    const code = 'code' in credential ? credential.code : undefined
    if (!vault.totp || !code || (await verifyTotp(vault.totp.secret, code)) === null) throw new PortableError('The login details don’t match this file.')
  }
  const { slots: _s, salt: _salt, iv: _iv, ...rest } = header
  return { header: rest, master, vault, dbFile: plain.subarray(4 + vaultLen), usedRecovery }
}

/* ---------- Sync files (.kbsync) ---------- */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buf(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Opens a sync file: "KBSYNC1\n" | uint32 header length | header JSON | 12-byte IV | 16-byte tag |
 * AES-256-GCM(deflate-raw(JSON)). The magic and header are the associated data. `expect` must match
 * the header (kind, groupId, device, seq), so a file can't be swapped for another.
 */
export async function openSyncFile<T>(syncKeyHex: string, file: Uint8Array, expect: Record<string, unknown>): Promise<T> {
  const MAGIC = 'KBSYNC1\n'
  if (file.length < MAGIC.length + 4 + 28 || !startsWith(file, MAGIC)) throw new PortableError('Not a sync file.')
  const hl = u32(file, MAGIC.length)
  const hStart = MAGIC.length + 4
  const h = file.subarray(hStart, hStart + hl)
  const header = JSON.parse(dec.decode(h)) as Record<string, unknown>
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) throw new PortableError(`Sync file header ${k} doesn’t match.`)
  const iv = file.subarray(hStart + hl, hStart + hl + 12)
  const tag = file.subarray(hStart + hl + 12, hStart + hl + 28)
  const ct = file.subarray(hStart + hl + 28)
  const key = Uint8Array.from(syncKeyHex.match(/../g)!.map((x) => parseInt(x, 16)))
  const plain = await aesGcmOpen(key, iv, concat(ct, tag), concat(enc.encode(MAGIC), h))
  if (!plain) throw new PortableError('This sync file is damaged, or the sync key is wrong.')
  return JSON.parse(dec.decode(await inflateRaw(plain))) as T
}
