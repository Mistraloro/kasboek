import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { coreOps, runOp } from '@core/ops'

const fresh = () => ({ db: openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-')), 'k.db'), randomBytes(32).toString('hex')), actor: 'user' as const })

describe('operations', () => {
  it('validates input and normalises IBANs', async () => {
    const ctx = fresh()
    const bad = await runOp(coreOps, ctx, 'accounts.create', { name: '', bank: 'argenta' })
    expect(bad.ok).toBe(false)
    const unknownBank = await runOp(coreOps, ctx, 'accounts.create', { name: 'X', bank: 'mybank' })
    expect(unknownBank.ok).toBe(false)

    const ok = await runOp(coreOps, ctx, 'accounts.create', { name: 'Hello bank!', bank: 'hellobank', iban: 'be68 5390 0754 7034' })
    expect(ok).toMatchObject({ ok: true, data: { iban: 'BE68539007547034', currency: 'EUR' } })

    const dup = await runOp(coreOps, ctx, 'accounts.create', { name: 'Again', bank: 'hellobank', iban: 'BE68539007547034' })
    expect(dup).toMatchObject({ ok: false, error: { code: 'accounts.duplicate_iban' } })
  })

  it('records changes in the audit log, with the actor', async () => {
    const ctx = fresh()
    await runOp(coreOps, { ...ctx, actor: 'assistant' }, 'accounts.create', { name: 'Argenta', bank: 'argenta' })
    await runOp(coreOps, ctx, 'accounts.list', {})
    const log = ctx.db.prepare('SELECT actor, action FROM audit_log').all()
    expect(log).toEqual([{ actor: 'assistant', action: 'accounts.create' }])
  })

  it('rejects unknown fields and unknown operations', async () => {
    const ctx = fresh()
    expect((await runOp(coreOps, ctx, 'settings.update', { currency: 'EUR', evil: 1 })).ok).toBe(false)
    expect((await runOp(coreOps, ctx, 'nope' as 'settings.get', {})).ok).toBe(false)
    expect(await runOp(coreOps, ctx, 'settings.update', { currency: 'USD' })).toMatchObject({ ok: true, data: { currency: 'USD' } })
  })
})
