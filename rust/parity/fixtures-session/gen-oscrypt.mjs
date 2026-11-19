// Makes the fixtures for the safeStorage (Chromium OSCrypt) decoder of kb-session with Node's own crypto, from invented
// keys. The formats are documented in rust/crates/kb-session/src/oscrypt.rs. Run: node rust/parity/fixtures-session/gen-oscrypt.mjs
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const plain = JSON.stringify({ version: 2, mode: 'password', note: 'invented fixture, zoë ① ﬁ' })
const iv16 = Buffer.alloc(16, 0x20)

const gcm = (key, nonce) => {
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()])
}
const cbc = (prefix, password, iterations) => {
  const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
  const c = createCipheriv('aes-128-cbc', key, iv16)
  return Buffer.concat([Buffer.from(prefix), c.update(plain, 'utf8'), c.final()])
}

const winKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255))
// The test's stand-in for DPAPI reverses the bytes.
const fakeDpapiBlob = Buffer.from(winKey).reverse()
const localState = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), fakeDpapiBlob]).toString('base64') } })

const out = {
  plain,
  windows: { keyHex: winKey.toString('hex'), localState, blobHex: gcm(winKey, Buffer.from('000102030405060708090a0b', 'hex')).toString('hex') },
  macos: { password: 'invented-keychain-secret', blobHex: cbc('v10', 'invented-keychain-secret', 1003).toString('hex') },
  linuxV11: { password: 'invented-keyring-secret', blobHex: cbc('v11', 'invented-keyring-secret', 1).toString('hex') },
  linuxV10: { blobHex: cbc('v10', 'peanuts', 1).toString('hex') }
}
writeFileSync(join(import.meta.dirname, 'oscrypt.json'), JSON.stringify(out, null, 2) + '\n')
