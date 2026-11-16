/**
 * Sync files (.kbsync): "KBSYNC1\n" | uint32 header length | header JSON | 12-byte IV | 16-byte GCM tag |
 * AES-256-GCM(deflate-raw(payload JSON)), with the magic and header as associated data.
 * src/core/portable.ts reads the same format without Node.js (for a mobile app).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const MAGIC = Buffer.from('KBSYNC1\n')

export function sealSyncFile(key: Buffer, header: Record<string, unknown>, payload: unknown): Buffer {
  const h = Buffer.from(JSON.stringify(header))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.concat([MAGIC, h]))
  const ct = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(payload)))), cipher.final()])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(h.length)
  return Buffer.concat([MAGIC, len, h, iv, cipher.getAuthTag(), ct])
}

export function openSyncFile<T>(key: Buffer, file: Buffer, expect: Record<string, unknown>): T {
  if (file.length < MAGIC.length + 4 + 28 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sync file')
  const hl = file.readUInt32BE(MAGIC.length)
  const hStart = MAGIC.length + 4
  const h = file.subarray(hStart, hStart + hl)
  const header = JSON.parse(h.toString('utf8')) as Record<string, unknown>
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) throw new Error(`header ${k} mismatch`)
  const iv = file.subarray(hStart + hl, hStart + hl + 12)
  const tag = file.subarray(hStart + hl + 12, hStart + hl + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.concat([MAGIC, h]))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(file.subarray(hStart + hl + 28)), decipher.final()])
  return JSON.parse(inflateRawSync(plain, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')) as T
}

