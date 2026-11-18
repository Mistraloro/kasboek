import { describe, expect, it } from 'vitest'
import { PASSWORD_KDF, makeSlot, openSlot } from '@core/crypto'

// Every other test uses cheap parameters; this one keeps the real defaults honest.
describe('the real password KDF', () => {
  it('uses Argon2id with the full default cost and opens only with the right password', async () => {
    expect(PASSWORD_KDF).toEqual({ m: 128 * 1024, t: 3, p: 4 })
    const master = Buffer.alloc(32, 7)
    const slot = await makeSlot(master, 'correct horse battery', 'password')
    expect(slot.kdf).toMatchObject({ name: 'argon2id', m: 128 * 1024, t: 3, p: 4 })
    expect((await openSlot(slot, 'correct horse battery', 'password'))?.equals(master)).toBe(true)
    expect(await openSlot(slot, 'wrong', 'password')).toBeNull()
  })
})
