/** Reads one file from a ZIP archive (stored or deflated), using the central directory. */
import { inflateRawSync } from 'node:zlib'
import { AppError } from './errors'

const MAX_OUTPUT = 64 * 1024 * 1024

export function readZipEntry(zip: Buffer, match: (name: string) => boolean): Buffer | null {
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new AppError('zip.bad', 'This is not a valid ZIP file.')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new AppError('zip.bad', 'This ZIP file is damaged.')
    const method = zip.readUInt16LE(p + 10)
    const compressed = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (!match(name)) continue
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new AppError('zip.bad', 'This ZIP file is damaged.')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + compressed)
    if (method === 0) return Buffer.from(data)
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_OUTPUT })
    throw new AppError('zip.method', 'This ZIP file uses an unsupported compression method.')
  }
  return null
}
