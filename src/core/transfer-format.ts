/**
 * Kasboek export / backup file (.kasboek), format 2.
 *
 *   "KASBOEK2" | uint32 header length | header JSON | ciphertext | 16-byte GCM tag
 *
 * The payload (vault + still-encrypted database) is sealed with a key derived from the
 * master key. The header carries the password and recovery-key slots, so the file opens
 * with exactly the login credentials, on any computer, but only through Import in Kasboek.
 * It deliberately has no device seal: that's what makes it portable.
 * The header is bound to the payload as associated data, so it can't be altered.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AccountData, AuthMode, Vault } from './account'
import { hkdf, openSlot, type Slot } from './crypto'
import { AppError } from './errors'
import { normalizeRecoveryKey, verifyTotp } from './totp'

const MAGIC = Buffer.from('KASBOEK2', 'ascii')
const MAX_HEADER = 64 * 1024
export const TRANSFER_EXTENSION = 'kasboek'

export interface TransferHeader {
  format: 2
  kind: 'export' | 'backup'
  createdAt: string
  appVersion: string
  schemaVersion: number
  mode: AuthMode
  twoFactor: boolean
  slots: { password?: Slot; recovery: Slot }
  salt: string
  iv: string
}

export interface TransferContents {
  header: TransferHeader
  master: Buffer
  vault: Vault
  dbFile: Buffer
  /** True when opened with the recovery key (the password should be reset). */
  usedRecovery: boolean
}

export function encodeTransfer(input: {
  kind: TransferHeader['kind']
  account: AccountData
  master: Buffer
  vault: Vault
  dbFile: Buffer
  appVersion: string
  schemaVersion: number
}): Buffer {
  const header: TransferHeader = {
    format: 2,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    mode: input.account.mode,
    twoFactor: input.account.twoFactor,
    slots: {
      recovery: input.account.slots.recovery,
      ...(input.account.slots.password ? { password: input.account.slots.password } : {})
    },
    salt: randomBytes(16).toString('base64'),
    iv: randomBytes(12).toString('base64')
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(MAGIC.length + 4)
  MAGIC.copy(prefix)
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length)
  const aad = Buffer.concat([prefix, headerBytes])

  const vaultBytes = Buffer.from(JSON.stringify(input.vault), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(vaultBytes.length)

  const key = hkdf(input.master, Buffer.from(header.salt, 'base64'), 'kasboek:file:v2')
  const c = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  c.setAAD(aad)
  const body = Buffer.concat([c.update(len), c.update(vaultBytes), c.update(input.dbFile), c.final()])
  return Buffer.concat([aad, body, c.getAuthTag()])
}

function split(file: Buffer) {
  if (file.length < MAGIC.length + 4 || !timingSafeEqual(file.subarray(0, MAGIC.length), MAGIC)) {
    if (file.subarray(0, 8).toString('ascii') === 'KASBOEK1') {
      throw new AppError('transfer.old_format', 'This backup was made by an early test version and can’t be imported.')
    }
    throw new AppError('transfer.not_kasboek', 'This file is not a Kasboek export.')
  }
  const headerLen = file.readUInt32BE(MAGIC.length)
  const end = MAGIC.length + 4 + headerLen
  if (headerLen === 0 || headerLen > MAX_HEADER || file.length < end + 16) throw new AppError('transfer.corrupt', 'This file is damaged.')
  let header: TransferHeader
  try {
    header = JSON.parse(file.subarray(MAGIC.length + 4, end).toString('utf8'))
  } catch {
    throw new AppError('transfer.corrupt', 'This file is damaged.')
  }
  if (header.format !== 2) throw new AppError('transfer.unsupported', 'This file was made by a newer version of Kasboek.')
  return { header, aad: file.subarray(0, end), body: file.subarray(end, file.length - 16), tag: file.subarray(file.length - 16) }
}

/** The readable header only. Trust it only after `openTransfer` succeeds. */
export function readTransferHeader(file: Buffer): TransferHeader {
  return split(file).header
}

/**
 * Opens an export with the password (+ 2FA code if the account uses 2FA) or with the recovery key.
 * Errors don't say which part was wrong.
 */
export async function openTransfer(
  file: Buffer,
  credential: { password: string; code?: string } | { recoveryKey: string }
): Promise<TransferContents> {
  const { header, aad, body, tag } = split(file)
  const fail = (): never => {
    throw new AppError('transfer.wrong_credentials', 'The login details don’t match this file.')
  }

  let master: Buffer | null = null
  const usedRecovery = 'recoveryKey' in credential
  if ('recoveryKey' in credential) {
    master = await openSlot(header.slots.recovery, normalizeRecoveryKey(credential.recoveryKey), 'recovery')
  } else if (header.slots.password) {
    master = await openSlot(header.slots.password, credential.password, 'password')
  } else {
    throw new AppError('transfer.needs_recovery', 'This export comes from a passwordless account. Use your recovery key.')
  }
  if (!master) return fail()

  const key = hkdf(master, Buffer.from(header.salt, 'base64'), 'kasboek:file:v2')
  let plain: Buffer
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
    d.setAAD(aad)
    d.setAuthTag(tag)
    plain = Buffer.concat([d.update(body), d.final()])
  } catch {
    throw new AppError('transfer.corrupt', 'This file is damaged or has been changed.')
  }
  const vaultLen = plain.readUInt32BE(0)
  let vault = JSON.parse(plain.subarray(4, 4 + vaultLen).toString('utf8')) as Vault
  const dbFile = plain.subarray(4 + vaultLen)

  if (!usedRecovery && header.twoFactor) {
    const code = 'code' in credential ? credential.code : undefined
    const step = vault.totp && code ? verifyTotp(vault.totp.secret, code, -1) : null
    if (step === null) return fail()
    vault = { ...vault, totp: { ...vault.totp!, lastStep: step } }
  }
  return { header, master, vault, dbFile, usedRecovery }
}
