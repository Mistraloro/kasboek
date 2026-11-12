/**
 * Kasboek backup file (.kasboek).
 *
 *   "KASBOEK1" | uint32 header length | header JSON | ciphertext | 16-byte GCM tag
 *
 * The header (creation date, app version, KDF salt, IV) is readable without the
 * password, so the app can show what a backup is before asking for it. It is
 * bound to the ciphertext as additional authenticated data, so it can't be changed.
 *
 * The encrypted payload is the database key followed by the database file. The
 * database file is itself still encrypted with that key, so it is never
 * written anywhere in plain form. Restoring needs only the backup password,
 * which is why a backup also works on a new computer.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { AppError } from './errors'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

const MAGIC = Buffer.from('KASBOEK1', 'ascii')
const TAG_LEN = 16
const DB_KEY_LEN = 32
const MAX_HEADER = 64 * 1024

export const BACKUP_EXTENSION = 'kasboek'

export interface BackupHeader {
  format: 1
  createdAt: string
  appVersion: string
  schemaVersion: number
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: 'aes-256-gcm'
  iv: string
}

export interface BackupContents {
  header: BackupHeader
  dbKeyHex: string
  dbFile: Buffer
}

/** scrypt cost. 2^17 takes roughly 0.3–0.5 s on a laptop, which makes guessing passwords slow. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 }

async function deriveKey(password: string, kdf: BackupHeader['kdf']): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024
  })
}

export async function encodeBackup(input: {
  password: string
  dbKeyHex: string
  dbFile: Buffer
  appVersion: string
  schemaVersion: number
  createdAt?: Date
  kdf?: { N: number; r: number; p: number }
}): Promise<Buffer> {
  const dbKey = Buffer.from(input.dbKeyHex, 'hex')
  if (dbKey.length !== DB_KEY_LEN) throw new AppError('backup.bad_key', 'Database key must be 32 bytes.')

  const kdfParams = input.kdf ?? DEFAULT_KDF
  const header: BackupHeader = {
    format: 1,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    kdf: { name: 'scrypt', ...kdfParams, salt: randomBytes(16).toString('base64') },
    cipher: 'aes-256-gcm',
    iv: randomBytes(12).toString('base64')
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(MAGIC.length + 4)
  MAGIC.copy(prefix, 0)
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length)
  const aad = Buffer.concat([prefix, headerBytes])

  const key = await deriveKey(input.password, header.kdf)
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(dbKey), cipher.update(input.dbFile), cipher.final()])
  return Buffer.concat([aad, body, cipher.getAuthTag()])
}

function split(file: Buffer): { header: BackupHeader; aad: Buffer; body: Buffer; tag: Buffer } {
  if (file.length < MAGIC.length + 4 || !timingSafeEqual(file.subarray(0, MAGIC.length), MAGIC)) {
    throw new AppError('backup.not_a_backup', 'This file is not a Kasboek backup.')
  }
  const headerLen = file.readUInt32BE(MAGIC.length)
  const headerEnd = MAGIC.length + 4 + headerLen
  if (headerLen === 0 || headerLen > MAX_HEADER || file.length < headerEnd + TAG_LEN) {
    throw new AppError('backup.corrupt', 'This backup file is damaged.')
  }
  let header: BackupHeader
  try {
    header = JSON.parse(file.subarray(MAGIC.length + 4, headerEnd).toString('utf8'))
  } catch {
    throw new AppError('backup.corrupt', 'This backup file is damaged.')
  }
  if (header.format !== 1 || header.cipher !== 'aes-256-gcm' || header.kdf?.name !== 'scrypt') {
    throw new AppError('backup.unsupported', 'This backup was made by a newer version of Kasboek.')
  }
  return {
    header,
    aad: file.subarray(0, headerEnd),
    body: file.subarray(headerEnd, file.length - TAG_LEN),
    tag: file.subarray(file.length - TAG_LEN)
  }
}

/** Reads the unencrypted header only. Not authenticated until `decodeBackup` succeeds. */
export function readBackupHeader(file: Buffer): BackupHeader {
  return split(file).header
}

export async function decodeBackup(file: Buffer, password: string): Promise<BackupContents> {
  const { header, aad, body, tag } = split(file)
  // Cap the KDF cost so a crafted file can't make the app hang.
  if (header.kdf.N > 2 ** 20 || header.kdf.r > 16 || header.kdf.p > 4) {
    throw new AppError('backup.unsupported', 'This backup uses settings this version cannot open.')
  }
  const key = await deriveKey(password, header.kdf)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new AppError('backup.wrong_password', 'Wrong password, or the backup file has been changed.')
  }
  if (plain.length <= DB_KEY_LEN) throw new AppError('backup.corrupt', 'This backup file is damaged.')
  return {
    header,
    dbKeyHex: plain.subarray(0, DB_KEY_LEN).toString('hex'),
    dbFile: plain.subarray(DB_KEY_LEN)
  }
}

/** File name like `kasboek-2026-11-12_2140.kasboek`, safe on every OS. */
export function backupFileName(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  return `kasboek-${stamp}.${BACKUP_EXTENSION}`
}
