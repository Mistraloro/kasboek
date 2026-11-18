import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { insertTransaction, setBudget } from '@core/finance'
import { setBankBalance } from '@core/balance'
import { setManualRate } from '@core/fx'
import { INSIGHT_LIMITS, buildFacts, giveFeedback, hashFacts, restoreDismissed } from '@core/insights'
import { coreOps, runOp } from '@core/ops'
import { findRecurring, setRecurringHidden } from '@core/recurring'
import { actionOf, bodyKey, severityOf, textVars, titleKey } from '@shared/insights'
import type { InsightFact, InsightKind } from '@shared/types'

const TODAY = '2026-11-10'
const NOW = '2026-11'
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10']

function setup(currency = 'EUR') {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-tips-')), 'k.db'), randomBytes(32).toString('hex'))
  // Nothing here needs to survive a crash; skipping the disk flush per statement keeps slow disks (Windows CI) fast.
  d.pragma('synchronous = OFF')
  const a = Number(d.prepare("INSERT INTO accounts (name, kind, currency) VALUES ('Current', 'current', ?)").run(currency).lastInsertRowid)
  const pay = (date: string, cents: number, name: string, extra: Record<string, unknown> = {}, account = a) =>
    insertTransaction(d, { accountId: account, bookingDate: date, amountCents: cents, description: `${name} ${date}`, counterpartyName: name, ...extra })
  const monthly = (name: string, cents: number, day = '05', months = MONTHS, account = a) => months.forEach((m) => pay(`${m}-${day}`, cents, name, {}, account))
  const category = (name: string, kind = 'expense') => Number(d.prepare('INSERT INTO categories (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid)
  return { d, a, pay, monthly, category }
}
const kinds = (facts: InsightFact[]): InsightKind[] => facts.map((f) => f.kind)
const of = (facts: InsightFact[], kind: InsightKind): InsightFact[] => facts.filter((f) => f.kind === kind)

describe('price rises', () => {
  it('fires for a dearer payment, not for a cheaper one, and only while the last payment is recent', () => {
    const { d, monthly, pay } = setup()
    monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    pay('2026-10-05', -1500, 'Streamly')
    const [fact] = of(buildFacts(d, NOW, TODAY), 'price_up')
    expect(fact).toMatchObject({ key: 'price_up:out:streamly:2026-10', recurringKey: 'out:streamly', weight: 300 })
    expect(fact!.values).toEqual({ name: { text: 'Streamly' }, from: { money: 1200, currency: 'EUR' }, to: { money: 1500, currency: 'EUR' }, change: { money: 300, currency: 'EUR' }, date: { date: '2026-10-05' } })
    expect(fact!.transactionIds).toHaveLength(4)
    // The last payment was on 2026-10-05: 60 days later still counts, 61 does not.
    expect(of(buildFacts(d, '2026-12', '2026-12-04'), 'price_up')).toHaveLength(1)
    expect(of(buildFacts(d, '2026-12', '2026-12-05'), 'price_up')).toHaveLength(0)
    expect(INSIGHT_LIMITS.priceUpDays).toBe(60)
  })

  it('stays quiet when the price went down', () => {
    const { d, monthly, pay } = setup()
    monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    pay('2026-10-05', -900, 'Streamly')
    expect(findRecurring(d, TODAY).items[0]!.priceChangeCents).toBe(300)
    expect(of(buildFacts(d, NOW, TODAY), 'price_up')).toEqual([])
  })
})

describe('a payment taken twice', () => {
  const scenario = (second: number) => {
    const s = setup()
    s.monthly('Streamly', -1200)
    s.pay('2026-10-06', -second, 'Streamly')
    return s
  }
  it('fires when both payments are within 10% of the usual amount, not just beyond', () => {
    // The usual amount is the newest price when it is near the others, so 1333 is the limit for 1200.
    const at = scenario(1333)
    const [fact] = of(buildFacts(at.d, NOW, TODAY), 'charged_twice')
    expect(fact).toMatchObject({ key: 'charged_twice:out:streamly:2026-10', recurringKey: 'out:streamly' })
    expect(fact!.values).toMatchObject({ amount: { money: 1333, currency: 'EUR' }, count: { count: 2 }, date: { date: '2026-10-06' } })
    expect(fact!.transactionIds).toHaveLength(2)
    expect(of(buildFacts(scenario(1334).d, NOW, TODAY), 'charged_twice')).toEqual([])
  })

  it('needs both payments within the last 60 days', () => {
    const { d } = scenario(1200)
    expect(of(buildFacts(d, '2026-12', '2026-12-04'), 'charged_twice')).toHaveLength(1)
    expect(of(buildFacts(d, '2026-12', '2026-12-05'), 'charged_twice')).toHaveLength(0)
  })

  it('is not fired by a normal run of payments', () => {
    const { d, monthly } = setup()
    monthly('Streamly', -1200)
    expect(of(buildFacts(d, NOW, TODAY), 'charged_twice')).toEqual([])
  })
})

describe('late payments', () => {
  it('fires for a cost that did not arrive, with the date it was expected', () => {
    const { d, monthly } = setup()
    monthly('Flat Owner', -90000, '20', MONTHS.slice(0, 3))
    const [fact] = of(buildFacts(d, NOW, TODAY), 'late')
    expect(fact).toMatchObject({ key: 'late:out:flat owner:2026-10-20', weight: 90000 })
    expect(fact!.values).toMatchObject({ amount: { money: 90000, currency: 'EUR' }, date: { date: '2026-10-20' } })
  })

  it('does not fire when it was paid', () => {
    const { d, monthly } = setup()
    monthly('Flat Owner', -90000, '20')
    expect(of(buildFacts(d, NOW, TODAY), 'late')).toEqual([])
  })
})

describe('costs coming up', () => {
  it('fires for a quarterly cost due within 30 days, not 31', () => {
    const { d, pay } = setup()
    for (const date of ['2026-02-15', '2026-05-15', '2026-08-15']) pay(date, -30000, 'Insurer')
    // Next payment 2026-11-15.
    expect(of(buildFacts(d, '2026-10', '2026-10-16'), 'upcoming')).toHaveLength(1)
    expect(of(buildFacts(d, '2026-10', '2026-10-15'), 'upcoming')).toEqual([])
    expect(of(buildFacts(d, '2026-10', '2026-10-16'), 'upcoming')[0]).toMatchObject({ key: 'upcoming:out:insurer:2026-11-15' })
  })

  it('fires for a monthly cost of at least twice the median, not just below', () => {
    const run = (big: number) => {
      const { d, monthly } = setup()
      monthly('Streamly', -1000, '20')
      monthly('Gym Club', -1000, '20')
      monthly('Big Bill', -big, '20')
      return of(buildFacts(d, NOW, TODAY), 'upcoming').map((f) => f.values['name'])
    }
    expect(run(2000)).toEqual([{ text: 'Big Bill' }])
    expect(run(1999)).toEqual([])
  })
})

describe('budgets', () => {
  const spend = (cents: number) => {
    const s = setup()
    const groceries = s.category('Food shopping')
    s.pay('2026-11-03', -cents, 'Corner Shop', { categoryId: groceries })
    setBudget(s.d, { categoryId: groceries, month: NOW, amountCents: 10000 })
    return { ...s, groceries }
  }
  const budgetFacts = (facts: InsightFact[]): InsightFact[] => facts.filter((f) => f.kind === 'near_budget' || f.kind === 'over_budget')
  it('is near from 80% and over beyond 100%, as in the warnings', () => {
    expect(budgetFacts(buildFacts(spend(7999).d, NOW, TODAY))).toEqual([])
    const near = budgetFacts(buildFacts(spend(8000).d, NOW, TODAY))
    expect(kinds(near)).toEqual(['near_budget'])
    expect(near[0]!.values).toMatchObject({ spent: { money: 8000, currency: 'EUR' }, budget: { money: 10000, currency: 'EUR' }, percent: { count: 80 } })
    expect(kinds(budgetFacts(buildFacts(spend(10000).d, NOW, TODAY)))).toEqual(['near_budget'])
    const s = spend(10001)
    const over = budgetFacts(buildFacts(s.d, NOW, TODAY))
    expect(over.map((f) => [f.kind, f.key])).toEqual([['over_budget', `over_budget:${NOW}:${s.groceries}`]])
    expect(over[0]!.categoryId).toBe(s.groceries)
  })

  it('works for the month shown, also a past one', () => {
    const s = setup()
    const c = s.category('Food shopping')
    s.pay('2026-09-03', -12000, 'Corner Shop', { categoryId: c })
    setBudget(s.d, { categoryId: c, month: '2026-09', amountCents: 10000 })
    expect(kinds(buildFacts(s.d, '2026-09', TODAY))).toContain('over_budget')
    expect(kinds(buildFacts(s.d, NOW, TODAY))).not.toContain('over_budget')
  })
})

describe('a category that grew', () => {
  const run = (usual: number, october: number, month = NOW) => {
    const s = setup()
    const c = s.category('Food shopping')
    for (const m of ['2026-07', '2026-08', '2026-09']) s.pay(`${m}-03`, -usual, 'Corner Shop', { categoryId: c })
    s.pay('2026-10-03', -october, 'Corner Shop', { categoryId: c })
    return { ...s, c, facts: of(buildFacts(s.d, month, TODAY), 'category_up') }
  }
  it('fires at +25% and 50 units, not just below either', () => {
    const at = run(20000, 25000)
    expect(at.facts).toHaveLength(1)
    expect(at.facts[0]).toMatchObject({ key: `category_up:2026-10:${at.c}`, categoryId: at.c, weight: 5000 })
    expect(at.facts[0]!.values).toMatchObject({ amount: { money: 25000, currency: 'EUR' }, average: { money: 20000, currency: 'EUR' }, percent: { count: 25 }, month: { text: '2026-10' } })
    expect(run(20000, 24999).facts).toEqual([])
    // 25% but only 25 units; 50 units but only 5%.
    expect(run(10000, 12500).facts).toEqual([])
    expect(run(100000, 105000).facts).toEqual([])
  })

  it('looks at a finished month: the one shown when past, else the month before', () => {
    const s = run(20000, 25000)
    expect(of(buildFacts(s.d, '2026-10', TODAY), 'category_up')).toHaveLength(1)
    // July has no spending in the three months before it to compare with.
    expect(of(buildFacts(s.d, '2026-07', TODAY), 'category_up')).toEqual([])
    // A spike in the running month is not judged before it is over.
    s.pay('2026-11-04', -90000, 'Corner Shop', { categoryId: s.c })
    expect(of(buildFacts(s.d, NOW, TODAY), 'category_up').map((f) => f.key)).toEqual([`category_up:2026-10:${s.c}`])
    // A month still to come is reviewed through the last finished one too.
    expect(of(buildFacts(s.d, '2026-12', TODAY), 'category_up').map((f) => f.key)).toEqual([`category_up:2026-10:${s.c}`])
  })
})

describe('unusual payments', () => {
  it('lists what the review finds for the month shown', () => {
    const { d, pay, category } = setup()
    const food = category('Food shopping')
    for (const m of ['2026-07', '2026-08', '2026-09']) {
      pay(`${m}-03`, -30000, 'Corner Shop', { categoryId: food })
      pay(`${m}-10`, -1500, 'Garage')
    }
    pay('2026-10-10', -9000, 'Garage')
    const big = pay('2026-10-20', -60000, 'New laptop shop')
    const facts = of(buildFacts(d, '2026-10', TODAY), 'unusual')
    expect(facts.map((f) => [f.values['name'], f.values['reason']])).toEqual([[{ text: 'New laptop shop' }, { text: 'new' }], [{ text: 'Garage' }, { text: 'higher' }]])
    expect(facts[0]).toMatchObject({ key: `unusual:${big}`, transactionIds: [big], weight: 60000 })
    expect(facts[1]!.values['usual']).toEqual({ money: 1500, currency: 'EUR' })
    expect(of(buildFacts(d, NOW, TODAY), 'unusual')).toEqual([])
  })
})

describe('categories without a budget', () => {
  const run = (months: number[], budget = false) => {
    const s = setup()
    const c = s.category('Food shopping')
    ;['2026-08', '2026-09', '2026-10'].forEach((m, i) => months[i] && s.pay(`${m}-03`, -months[i]!, 'Corner Shop', { categoryId: c }))
    if (budget) setBudget(s.d, { categoryId: c, month: NOW, amountCents: 1000 })
    return { ...s, c, facts: of(buildFacts(s.d, NOW, TODAY), 'no_budget') }
  }
  it('fires at an average of 100 units over each of the last three months, not just below', () => {
    const at = run([10000, 10000, 10000])
    expect(at.facts).toHaveLength(1)
    expect(at.facts[0]).toMatchObject({ key: `no_budget:${NOW}:${at.c}`, categoryId: at.c, weight: 10000 })
    expect(at.facts[0]!.values['average']).toEqual({ money: 10000, currency: 'EUR' })
    expect(run([10000, 10000, 9999]).facts).toEqual([])
  })
  it('needs spending in every one of the months, and no budget this month', () => {
    expect(run([0, 15000, 15000]).facts).toEqual([])
    expect(run([10000, 10000, 10000], true).facts).toEqual([])
  })
})

describe('a balance heading below zero', () => {
  it('comes from the balance warning, for the running month only', () => {
    const { d, a, monthly } = setup()
    monthly('Employer', 200000, '25')
    monthly('Landlord', -90000, '20')
    setBankBalance(d, { accountId: a, date: TODAY, balanceCents: 50000 }, TODAY)
    const [fact] = of(buildFacts(d, NOW, TODAY), 'balance_low')
    expect(fact).toMatchObject({ key: `balance_low:${a}:2026-11-25`, weight: 40000 })
    expect(fact!.values).toMatchObject({ lowest: { money: -40000, currency: 'EUR' }, balance: { money: 50000, currency: 'EUR' }, due: { money: 90000, currency: 'EUR' }, date: { date: '2026-11-25' } })
    expect(of(buildFacts(d, '2026-10', TODAY), 'balance_low')).toEqual([])
  })
})

describe('fixed costs together', () => {
  it('sums the monthly cost of the cost items, from two of them up', () => {
    const { d, monthly } = setup()
    monthly('Streamly', -1200)
    expect(of(buildFacts(d, NOW, TODAY), 'subscriptions')).toEqual([])
    monthly('Gym Club', -2000)
    const [fact] = of(buildFacts(d, NOW, TODAY), 'subscriptions')
    expect(fact!.values).toEqual({ count: { count: 2 }, amount: { money: 3200, currency: 'EUR' }, names: { text: 'Gym Club, Streamly' } })
    expect(fact).toMatchObject({ key: `subscriptions:${NOW}`, weight: 3200, recurringKey: null })
  })
})

describe('what is left out', () => {
  it('never uses income as a fact', () => {
    const { d, monthly, pay, category } = setup()
    const salary = category('Pay', 'income')
    // A salary that rose and then is late, a bonus, and a fixed cost for company.
    monthly('Employer', 200000, '25', MONTHS.slice(0, 3))
    pay('2026-09-25', 260000, 'Employer', { categoryId: salary })
    pay('2026-10-12', 900000, 'Big Bonus Ltd', { categoryId: salary })
    monthly('Streamly', -1200)
    const wanted = category('Food shopping')
    for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) pay(`${m}-03`, -10000, 'Corner Shop', { categoryId: wanted })
    for (const month of [NOW, '2026-10']) {
      const facts = buildFacts(d, month, TODAY)
      expect(facts.length).toBeGreaterThan(0)
      expect(facts.filter((f) => f.recurringKey?.startsWith('in:'))).toEqual([])
      const text = JSON.stringify(facts)
      expect(text).not.toContain('Employer')
      expect(text).not.toContain('Bonus')
      expect(text).not.toMatch(/"money":(200000|260000|900000)/)
    }
  })

  it('leaves out fixed costs the person said are not fixed', () => {
    const { d, monthly, pay } = setup()
    monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    pay('2026-10-05', -1500, 'Streamly')
    monthly('Gym Club', -2000)
    expect(of(buildFacts(d, NOW, TODAY), 'price_up')).toHaveLength(1)
    setRecurringHidden(d, 'out:streamly', true, TODAY)
    const facts = buildFacts(d, NOW, TODAY)
    expect(facts.filter((f) => f.recurringKey === 'out:streamly')).toEqual([])
    expect(of(facts, 'subscriptions')).toEqual([])
  })

  it('leaves out the tips that were hidden or marked not useful, and brings them back', () => {
    const { d, monthly, pay } = setup()
    monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    pay('2026-10-05', -1500, 'Streamly')
    monthly('Gym Club', -2000)
    const all = buildFacts(d, NOW, TODAY)
    const price = of(all, 'price_up')[0]!
    const subs = of(all, 'subscriptions')[0]!
    giveFeedback(d, price.key, 'dismissed')
    giveFeedback(d, subs.key, 'not_useful')
    expect(buildFacts(d, NOW, TODAY).map((f) => f.key)).toEqual(all.map((f) => f.key).filter((k) => k !== price.key && k !== subs.key))
    // "Useful" is only remembered: the tip stays.
    giveFeedback(d, price.key, 'useful')
    expect(buildFacts(d, NOW, TODAY).map((f) => f.key)).toContain(price.key)
    giveFeedback(d, price.key, 'dismissed')
    expect(restoreDismissed(d)).toEqual({ restored: 2 })
    expect(buildFacts(d, NOW, TODAY).map((f) => f.key)).toEqual(all.map((f) => f.key))
    expect(restoreDismissed(d)).toEqual({ restored: 0 })
  })
})

describe('currencies', () => {
  it('keeps a cost in its account currency and sizes it in the main currency', () => {
    const { d, a, monthly, pay } = setup('EUR')
    const usd = Number(d.prepare("INSERT INTO accounts (name, kind, currency) VALUES ('Dollar', 'current', 'USD')").run().lastInsertRowid)
    const yen = Number(d.prepare("INSERT INTO accounts (name, kind, currency) VALUES ('Yen', 'current', 'JPY')").run().lastInsertRowid)
    setManualRate(d, { currency: 'USD', date: '2026-01-01', perEur: 2 })
    monthly('Streamly', -2000, '05', MONTHS.slice(0, 3), usd)
    pay('2026-10-05', -2400, 'Streamly', {}, usd)
    monthly('Gym Club', -1000, '05', MONTHS, a)
    // No exchange rate for yen: its price rise is still shown, in yen, but it is left out of the sums.
    monthly('Noodle Box', -100000, '07', MONTHS.slice(0, 3), yen)
    pay('2026-10-07', -120000, 'Noodle Box', {}, yen)
    const facts = buildFacts(d, NOW, TODAY)
    const prices = of(facts, 'price_up')
    const usdFact = prices.find((f) => f.recurringKey === 'out:streamly')!
    expect(usdFact.values['change']).toEqual({ money: 400, currency: 'USD' })
    expect(usdFact.weight).toBe(200)
    const yenFact = prices.find((f) => f.recurringKey === 'out:noodle box')!
    expect(yenFact.values['change']).toEqual({ money: 20000, currency: 'JPY' })
    expect(yenFact.weight).toBe(0)
    const [subs] = of(facts, 'subscriptions')
    // Streamly 2400 USD-cents a month is 1200 in euro, plus the gym.
    expect(subs!.values).toMatchObject({ count: { count: 2 }, amount: { money: 2200, currency: 'EUR' } })
    for (const f of facts) for (const v of Object.values(f.values)) if ('money' in v) expect(v.currency).toMatch(/^[A-Z]{3}$/)
  })
})

describe('the list of facts', () => {
  it('is sorted by size and holds at most 30', () => {
    const { d, pay, category } = setup()
    d.transaction(() => {
      for (let i = 0; i < 35; i++) {
        const c = category(`Cat ${i}`)
        pay(`2026-11-03`, -(9000 + i * 10), `Shop ${i}`, { categoryId: c, description: `buy ${i}` })
        setBudget(d, { categoryId: c, month: NOW, amountCents: 10000 })
      }
    })()
    const facts = buildFacts(d, NOW, TODAY)
    expect(facts).toHaveLength(INSIGHT_LIMITS.maxFacts)
    expect(facts.map((f) => f.weight)).toEqual([...facts.map((f) => f.weight)].sort((x, y) => y - x))
    expect(facts[0]!.weight).toBe(9340)
    expect(facts.map((f) => f.id)).toEqual(facts.map((_, i) => `f${i + 1}`))
  })

  it('has transaction ids of at most 20', () => {
    const { d, monthly } = setup()
    for (let m = 0; m < 24; m++) monthly('Streamly', -1200, '05', [`${2025 + Math.floor((m + 10) / 12)}-${String(((m + 10) % 12) + 1).padStart(2, '0')}`])
    for (const f of buildFacts(d, NOW, TODAY)) expect(f.transactionIds.length).toBeLessThanOrEqual(20)
  })
})

describe('hashing facts', () => {
  const scenario = () => {
    const s = setup()
    s.monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    s.pay('2026-10-05', -1500, 'Streamly')
    s.monthly('Gym Club', -2000)
    const c = s.category('Food shopping')
    s.pay('2026-11-03', -9000, 'Corner Shop', { categoryId: c })
    setBudget(s.d, { categoryId: c, month: NOW, amountCents: 10000 })
    return { ...s, c }
  }
  it('is the same on a later day when the data did not change, and without the ids', () => {
    const { d } = scenario()
    const first = buildFacts(d, NOW, TODAY)
    const later = buildFacts(d, NOW, '2026-11-12')
    expect(first.length).toBeGreaterThan(2)
    expect(hashFacts(later)).toBe(hashFacts(first))
    expect(hashFacts(first)).toMatch(/^[0-9a-f]{32}$/)
    expect(hashFacts([...first].reverse().map((f, i) => ({ ...f, id: `x${i}` })))).toBe(hashFacts(first))
  })
  it('changes with the data', () => {
    const { d, pay, c } = scenario()
    const before = hashFacts(buildFacts(d, NOW, TODAY))
    pay('2026-11-04', -500, 'Corner Shop', { categoryId: c })
    expect(hashFacts(buildFacts(d, NOW, TODAY))).not.toBe(before)
  })
})

describe('the operations', () => {
  it('give the facts, keep feedback, and are not tools for the assistant', async () => {
    const { d, monthly, pay } = setup()
    monthly('Streamly', -1200, '05', MONTHS.slice(0, 3))
    pay('2026-10-05', -1500, 'Streamly')
    monthly('Gym Club', -2000)
    const ctx = { db: d, actor: 'user' as const }
    for (const op of ['insights.get', 'insights.feedback', 'insights.restoreDismissed'] as const) expect(coreOps[op]?.assistant).toBe(false)
    expect(coreOps['insights.get']?.mutates).toBe(false)
    expect(coreOps['insights.feedback']?.mutates).toBe(true)

    const bad = await runOp(coreOps, ctx, 'insights.feedback', { key: 'x', verdict: 'maybe' })
    expect(bad.ok).toBe(false)
    const bad2 = await runOp(coreOps, ctx, 'insights.get', { month: 'November' })
    expect(bad2.ok).toBe(false)

    const key = 'price_up:out:streamly:2026-10'
    expect(await runOp(coreOps, ctx, 'insights.feedback', { key, verdict: 'not_useful' })).toEqual({ ok: true, data: { ok: true } })
    expect(d.prepare('SELECT key, verdict FROM insight_feedback').all()).toEqual([{ key, verdict: 'not_useful' }])
    // The same tip again replaces the verdict instead of adding a row.
    await runOp(coreOps, ctx, 'insights.feedback', { key, verdict: 'dismissed' })
    expect(d.prepare('SELECT verdict FROM insight_feedback').all()).toEqual([{ verdict: 'dismissed' }])
    // The audit log says what happened, but not which payee.
    expect(d.prepare("SELECT action, details FROM audit_log WHERE action LIKE 'insights.%'").all()).toEqual([
      { action: 'insights.feedback', details: '{}' },
      { action: 'insights.feedback', details: '{}' }
    ])
    // Local only: nothing for sync.
    expect(d.prepare('SELECT count(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 })

    expect(await runOp(coreOps, ctx, 'insights.restoreDismissed', {})).toEqual({ ok: true, data: { restored: 1 } })
    expect(d.prepare('SELECT count(*) AS n FROM insight_feedback').get()).toEqual({ n: 0 })
  })
})

describe('how a tip is shown', () => {
  const all: InsightKind[] = ['price_up', 'charged_twice', 'late', 'upcoming', 'over_budget', 'near_budget', 'category_up', 'unusual', 'no_budget', 'balance_low', 'subscriptions']
  const fact = (kind: InsightKind, values: InsightFact['values'] = {}, categoryId: number | null = null): InsightFact => ({ id: 'f1', key: `${kind}:x`, kind, values, categoryId, recurringKey: null, transactionIds: [], weight: 1 })

  it('has a severity per kind', () => {
    expect(all.filter((k) => severityOf(k) === 'warning')).toEqual(['charged_twice', 'late', 'over_budget', 'balance_low'])
    expect(all.filter((k) => severityOf(k) === 'tip')).toEqual(['price_up', 'upcoming', 'category_up', 'no_budget', 'subscriptions'])
    expect(all.filter((k) => severityOf(k) === 'info')).toEqual(['near_budget', 'unusual'])
  })

  it('has a button per kind', () => {
    expect(actionOf(fact('price_up'))).toEqual({ label: 'fixedCosts', page: 'recurring' })
    expect(actionOf(fact('late'))).toEqual({ label: 'fixedCosts', page: 'recurring' })
    expect(actionOf(fact('balance_low'))).toEqual({ label: 'fixedCosts', page: 'recurring' })
    expect(actionOf(fact('over_budget', { month: { text: '2026-09' } }, 4))).toEqual({ label: 'budgets', page: 'budgets', params: { categoryId: 4, month: '2026-09' } })
    expect(actionOf(fact('no_budget', { month: { text: NOW } }, 4))).toEqual({ label: 'setBudget', page: 'budgets', params: { categoryId: 4, month: NOW } })
    expect(actionOf(fact('category_up', { month: { text: '2026-10' } }, 4))).toEqual({ label: 'category', page: 'transactions', params: { categoryId: 4, month: '2026-10' } })
    expect(actionOf(fact('charged_twice', { name: { text: 'Streamly' }, date: { date: '2026-10-06' } }))).toEqual({ label: 'payments', page: 'transactions', params: { search: 'Streamly', month: '2026-10' } })
  })

  it('has a title and a body in every language', () => {
    const dir = join(process.cwd(), 'src/renderer/src/i18n/locales')
    const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o)
    const fullLanguages = readdirSync(dir).filter((f) => f.endsWith('.json') && !['es-419.json', 'pt-BR.json'].includes(f))
    expect(fullLanguages).toHaveLength(6)
    for (const file of fullLanguages) {
      const texts = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown
      for (const kind of all) {
        const f = fact(kind, { reason: { text: 'new' } })
        const title = kind === 'subscriptions' ? `insights.subscriptions.title_other` : titleKey(f)
        for (const key of [title, bodyKey(f), ...(kind === 'unusual' ? [bodyKey(fact(kind, { reason: { text: 'higher' } }))] : [])]) expect(typeof get(texts, key), `${file} ${key}`).toBe('string')
      }
    }
  })

  it('writes the values the way the person set it up', () => {
    const vars = textVars(
      { name: { text: 'Streamly' }, amount: { money: 1500, currency: 'USD' }, date: { date: '2026-10-05' }, count: { count: 2 } },
      { money: (c, cur) => `${cur} ${c / 100}`, date: (iso) => `on ${iso}` }
    )
    expect(vars).toEqual({ name: 'Streamly', amount: 'USD 15', date: 'on 2026-10-05', count: 2 })
  })
})
