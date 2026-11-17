import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listAlerts } from '@core/alerts'
import { setBankBalance } from '@core/balance'
import { openDatabase } from '@core/database'
import { insertTransaction } from '@core/finance'
import { runOp, coreOps } from '@core/ops'
import { findRecurring, setRecurringHidden } from '@core/recurring'
import { toolName, assistantTools, describeChange } from '../src/main/assistant/tools'
import { addMonths, localToday } from '@shared/month'
import { DEFAULT_PERMISSIONS, needsApproval, kindOf, presetRules } from '@shared/permissions'

const TODAY = '2026-11-10'
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10']

function setup() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-hide-')), 'k.db'), randomBytes(32).toString('hex'))
  const a = Number(d.prepare("INSERT INTO accounts (name, kind) VALUES ('Current', 'current')").run().lastInsertRowid)
  const pay = (date: string, cents: number, name: string) => insertTransaction(d, { accountId: a, bookingDate: date, amountCents: cents, description: `${name} ${date}`, counterpartyName: name })
  for (const m of MONTHS) {
    pay(`${m}-05`, -1200, 'Streamly')
    pay(`${m}-20`, -90000, 'Flat Owner')
    pay(`${m}-25`, 200000, 'Acme Payroll')
  }
  return { d, a, pay }
}
const byName = (list: { name: string; key: string }[], name: string) => list.find((i) => i.name === name)!

describe('hiding a fixed cost', () => {
  it('leaves it out of the list and totals, and lists it as hidden; showing it again restores it', () => {
    const { d } = setup()
    const before = findRecurring(d, TODAY)
    expect(before.hidden).toEqual([])
    expect(before.monthlyOutCents).toBe(91200)
    const key = byName(before.items, 'Streamly').key
    expect(key).toMatch(/^out:/)

    const after = setRecurringHidden(d, key, true, TODAY)
    expect(after.items.map((i) => i.name).sort()).toEqual(['Acme Payroll', 'Flat Owner'])
    expect(after.hidden.map((i) => i.name)).toEqual(['Streamly'])
    expect(after.monthlyOutCents).toBe(90000)
    // Streamly was due on the 5th (still within the grace days): its amount is no longer due this month.
    expect(after.dueThisMonthCents).toBe(before.dueThisMonthCents - 1200)

    const again = setRecurringHidden(d, key, false, TODAY)
    expect(again).toEqual(before)
  })

  it('stays hidden when a new payment arrives, and tells income from cost by the key', () => {
    const { d, pay } = setup()
    const found = findRecurring(d, TODAY)
    const salary = byName(found.items, 'Acme Payroll')
    expect(salary.key).toMatch(/^in:/)
    setRecurringHidden(d, salary.key, true, TODAY)
    pay('2026-11-05', -1200, 'Streamly')
    pay('2026-11-25', 200000, 'Acme Payroll')
    const r = findRecurring(d, '2026-11-26')
    expect(r.hidden.map((i) => i.name)).toEqual(['Acme Payroll'])
    expect(r.items.map((i) => i.direction)).not.toContain('in')
    expect(r.monthlyInCents).toBe(0)
  })

  it('refuses a key that is not found, and keeps one mark per item', () => {
    const { d } = setup()
    expect(() => setRecurringHidden(d, 'out:nobody', true, TODAY)).toThrowError(expect.objectContaining({ code: 'recurring.not_found' }))
    expect(d.prepare('SELECT count(*) AS n FROM recurring_marks').get()).toEqual({ n: 0 })
    // Showing something that was never hidden is harmless.
    expect(() => setRecurringHidden(d, 'out:nobody', false, TODAY)).not.toThrow()
    const key = byName(findRecurring(d, TODAY).items, 'Streamly').key
    setRecurringHidden(d, key, true, TODAY)
    setRecurringHidden(d, key, false, TODAY)
    setRecurringHidden(d, key, true, TODAY)
    // Never deleted, so the row (and its sync id) stays.
    expect(d.prepare('SELECT key, hidden FROM recurring_marks').all()).toEqual([{ key, hidden: 1 }])
  })

  it('leaves hidden items out of the balance warning', () => {
    const { d, a } = setup()
    setBankBalance(d, { accountId: a, date: TODAY, balanceCents: 50000 }, TODAY)
    expect(listAlerts(d, TODAY).find((x) => x.kind === 'balance')).toMatchObject({ dueCents: 90000 })
    setRecurringHidden(d, byName(findRecurring(d, TODAY).items, 'Flat Owner').key, true, TODAY)
    expect(listAlerts(d, TODAY).find((x) => x.kind === 'balance')).toBeUndefined()
  })
})

describe('the recurring.hide operation', () => {
  it('is an assistant tool that changes data, asks like the other organising changes, and says what it does', async () => {
    const { d, pay } = setup()
    const tool = assistantTools().find((t) => t.op === 'recurring.hide')
    expect(tool).toMatchObject({ name: toolName('recurring.hide'), mutates: true })
    expect(tool!.name).toBe('recurring_hide')
    expect(kindOf('recurring.hide')).toBe('organise')
    expect(needsApproval(DEFAULT_PERMISSIONS, 'recurring.hide', { key: 'out:x' }, 'chat')).toBe(true)
    expect(needsApproval({ ...DEFAULT_PERMISSIONS, mode: 'smart' }, 'recurring.hide', { key: 'out:x' }, 'chat')).toBe(false)
    expect(needsApproval({ ...DEFAULT_PERMISSIONS, mode: 'custom', rules: { ...presetRules('smart'), organise: 'ask' } }, 'recurring.hide', { key: 'out:x' }, 'chat')).toBe(true)

    const ctx = { db: d, actor: 'user' as const }
    // The operation works from today's date, so this item is made from the last four months.
    for (let i = 4; i >= 1; i--) pay(`${addMonths(localToday().slice(0, 7), -i)}-05`, -700, 'Gym Club')
    const list = await runOp(coreOps, ctx, 'recurring.list', {})
    const key = list.ok ? byName(list.data.items, 'Gym Club').key : ''
    expect(describeChange(d, 'recurring.hide', { key })).toBe('Stop counting “Gym Club” as a fixed cost')
    expect(describeChange(d, 'recurring.hide', { key, hidden: false })).toBe('Count “Gym Club” as a fixed cost again')
    expect(describeChange(d, 'recurring.hide', { key: 'out:old gym' })).toBe('Stop counting “old gym” as a fixed cost')
    const hidden = await runOp(coreOps, ctx, 'recurring.hide', { key })
    expect(hidden.ok && hidden.data.hidden.map((i) => i.name)).toEqual(['Gym Club'])
    const shown = await runOp(coreOps, ctx, 'recurring.hide', { key, hidden: false })
    expect(shown.ok && shown.data.hidden).toEqual([])
    const refused = await runOp(coreOps, ctx, 'recurring.hide', { key: 'out:nobody' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'recurring.not_found' } })
    const invalid = await runOp(coreOps, ctx, 'recurring.hide', { key: 'streamly' })
    expect(invalid.ok).toBe(false)
  })
})
