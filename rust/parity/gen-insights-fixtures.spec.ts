// Writes rust/parity/fixtures/insights.json from the app's own TypeScript: the known answers the kb-core tests of the local insights
// compare with (skipped unless KB_WRITE_FIXTURES=1; the file is committed):
//   KB_WRITE_FIXTURES=1 npx vitest run --config rust/parity/vitest.config.ts gen-insights-fixtures
// - `localeCompare` of random strings (accents, digits, punctuation, mixed case, other scripts, combining marks) and sorted lists,
// - `hashFacts` of invented facts (odd keys, integer-like keys, fractions, negative zero, other scripts),
// - `factsPayload` of invented facts (rounding of halves, masking, cutting, balance accounts) and the system prompts.
// Everything is invented.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INSIGHT_INSTRUCTIONS, factsPayload, insightsSystem } from '@core/insight-plan'
import { hashFacts } from '@core/insights'
import type { InsightFact, InsightValue } from '@shared/types'
import { FIXTURES } from './helpers'

/** A small seeded generator (mulberry32), so the file is the same on every run. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL: string[] = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''),
  ...Array.from('àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿÀÁÂÄÇÈÉÊËÍÑÖØÙÜßœŒłŁšŠžŽćČđÐþ'),
  ...Array.from('αβγδΩабвгДЖ你好こんにちは한😀✓€£¼½'),
  '́', '̈', 'é', ' ', '\t', '\n', '–', '’', 'ä', 'ǆ', 'ﬁ', 'ª', '²', 'Ⅳ', 'ａ'
]
// Letters and digits more often than the rest, as the keys of real facts are.
const COMMON = Array.from('abcdeéèfghiïjklmnoöpqrstuüvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789   -_:.&')

function randomString(r: () => number): string {
  const n = Math.floor(r() * 12)
  let s = ''
  for (let i = 0; i < n; i++) s += r() < 0.7 ? COMMON[Math.floor(r() * COMMON.length)]! : POOL[Math.floor(r() * POOL.length)]!
  return s
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

const FACTS: InsightFact[] = [
  { id: 'f1', key: 'late:out:netflix:2026-11-05', kind: 'late', values: { name: { text: 'Netflix' }, amount: { money: 1299, currency: 'EUR' }, date: { date: '2026-11-05' } }, categoryId: null, recurringKey: 'out:netflix', transactionIds: [1, 2], weight: 1299 },
  { id: 'f2', key: 'subscriptions:2026-11', kind: 'subscriptions', values: { count: { count: 3 }, amount: { money: 150, currency: 'EUR' }, names: { text: 'Äpfel, Zebra | x, 1234 5678 9012 3456' } }, categoryId: null, recurringKey: null, transactionIds: [], weight: 150 },
  { id: 'f3', key: 'balance_low:3:2026-11-30', kind: 'balance_low', values: { name: { text: 'Tight' }, lowest: { money: -4000, currency: 'EUR' }, balance: { money: 2000, currency: 'EUR' }, due: { money: 6000, currency: 'EUR' }, date: { date: '2026-11-30' } }, categoryId: null, recurringKey: null, transactionIds: [], weight: 4000 },
  { id: 'f4', key: 'balance_low:4:2026-11-30', kind: 'balance_low', values: { name: { text: 'Other' }, lowest: { money: -1, currency: 'GBP' }, balance: { money: 5, currency: 'GBP' }, due: { money: 6, currency: 'GBP' }, date: { date: '2026-11-30' } }, categoryId: null, recurringKey: null, transactionIds: [], weight: 1 },
  { id: 'f5', key: 'balance_low:3:2026-12-31', kind: 'balance_low', values: { name: { text: 'Tight' }, lowest: { money: -4000, currency: 'EUR' }, balance: { money: 2000, currency: 'EUR' }, due: { money: 6000, currency: 'EUR' }, date: { date: '2026-12-31' } }, categoryId: null, recurringKey: null, transactionIds: [], weight: 1 },
  { id: 'f6', key: 'near_budget:2026-11:7', kind: 'near_budget', values: { name: { text: 'Mail a.b@example.org\nnow | then\tx   y' }, spent: { money: 150, currency: 'EUR' }, budget: { money: 250, currency: 'EUR' }, percent: { count: 13 }, month: { text: '2026-11' } }, categoryId: 7, recurringKey: null, transactionIds: [], weight: 150 },
  { id: 'f7', key: 'unusual:1', kind: 'unusual', values: { name: { text: '😀'.repeat(30) + 'Long name that goes on and on' }, amount: { money: 49, currency: 'EUR' }, usual: { money: 50, currency: 'EUR' }, date: { date: '2026-11-09' }, reason: { text: 'higher' } }, categoryId: null, recurringKey: null, transactionIds: [1], weight: 49 },
  { id: 'f8', key: 'unusual:2', kind: 'unusual', values: { name: { text: '' }, amount: { money: 51, currency: 'USD' }, date: { date: '2026-11-09' }, reason: { text: 'new' } }, categoryId: null, recurringKey: null, transactionIds: [2], weight: 51 },
  { id: 'f9', key: 'price_up:x:1', kind: 'price_up', values: { name: { text: 'Pay BE68 5390 0754 7034 shop' }, from: { money: 99950, currency: 'EUR' }, to: { money: 100050, currency: 'EUR' }, change: { money: 150, currency: 'EUR' }, date: { date: '2026-11-09' } }, categoryId: null, recurringKey: 'x', transactionIds: [], weight: 150 },
  { id: 'f10', key: 'price_up:y:1', kind: 'price_up', values: { name: { text: 'Card 4111 1111 1111 1111 Club +32 470 12 34 56' }, from: { money: 349, currency: 'EUR' }, to: { money: 350, currency: 'EUR' }, change: { money: -250, currency: 'EUR' }, date: { date: '2026-11-09' } }, categoryId: null, recurringKey: 'y', transactionIds: [], weight: 0 }
]

describe.runIf(process.env.KB_WRITE_FIXTURES === '1')('write insights fixtures', () => {
  it('writes insights.json', () => {
    const collation: { a: string; b: string; cmp: number }[] = []
    const r = rng(20261114)
    for (let i = 0; i < 3000; i++) {
      const a = randomString(r)
      // A third of the pairs differ only a little, which is where collation levels decide.
      const b = r() < 0.33 && a.length > 0 ? a.replace(/[a-z]/, (c) => c.toUpperCase()).replace(/e/, 'é') : randomString(r)
      collation.push({ a, b, cmp: sign(a.localeCompare(b)) })
    }
    for (const [a, b] of [['a', 'A'], ['a', 'á'], ['A', 'á'], ['-', '1'], ['_', '-'], ['1', 'a'], ['10', '2'], ['é', 'é'], ['ß', 'ss'], ['æ', 'ae'], ['', 'a'], ['a b', 'ab'], ['a-b', 'ab'], ['a_b', 'a b'], ['Zoo', 'zoo'], ['ǆ', 'dž'], ['ﬁ', 'fi'], ['out:ünder club', 'out:under club']] as const) collation.push({ a, b, cmp: sign(a.localeCompare(b)) })
    const lists = Array.from({ length: 8 }, () => {
      const items = Array.from({ length: 150 }, () => randomString(r))
      return { items, sorted: [...items].sort((x, y) => x.localeCompare(y)) }
    })

    const hashFixtures: { facts: unknown; hash: string }[] = []
    const mk = (key: string, values: Record<string, InsightValue>, kind = 'late'): InsightFact => ({ id: 'f1', key, kind: kind as InsightFact['kind'], values, categoryId: null, recurringKey: null, transactionIds: [], weight: 1 })
    const sets: InsightFact[][] = [
      [],
      FACTS,
      [...FACTS].reverse(),
      [mk('b', { x: { count: 1 } }), mk('B', { x: { count: 2 } }), mk('a', { x: { count: 3 } }), mk('é', { x: { count: 4 } }), mk('e', { x: { count: 5 } }), mk('-', { x: { count: 6 } }), mk('1', { x: { count: 7 } })],
      [mk('k', { '2': { text: 'two' }, b: { text: 'b' }, '1': { text: 'one' }, a: { money: 12.5, currency: 'EUR' }, '10': { count: -0 }, B: { date: '2026-01-01' }, é: { text: 'é' }, e: { text: 'e' }, _z: { text: '😀 "quoted" \\ \n\t\u0001 ' } })],
      [mk('m', { money: { money: 1e21, currency: 'EUR' } }), mk('n', { money: { money: 123456.789, currency: 'EUR' } }), mk('o', { money: { money: 0.1 + 0.2, currency: 'EUR' } }), mk('p', { money: { money: -0.5, currency: 'EUR' } })]
    ]
    for (const facts of sets) hashFixtures.push({ facts, hash: hashFacts(facts) })

    const payloads = [
      { facts: FACTS, opts: { currency: 'EUR', month: '2026-11', today: '2026-11-14' } },
      { facts: [], opts: { currency: 'USD', month: '2026-12', today: '2026-12-01' } },
      { facts: FACTS.slice(2, 5), opts: { currency: 'EUR', month: '2026-11', today: '2026-11-14' } }
    ].map((p) => ({ ...p, ...factsPayload(p.facts, p.opts) }))

    const systems = Object.fromEntries(['en', 'nl', 'fr', 'de', 'es', 'es-419', 'pt-PT', 'pt-BR', 'xx', ''].map((l) => [l, insightsSystem(l)]))

    mkdirSync(FIXTURES, { recursive: true })
    writeFileSync(join(FIXTURES, 'insights.json'), JSON.stringify({ collation, lists, hashes: hashFixtures, payloads, instructions: INSIGHT_INSTRUCTIONS, systems }))
    expect(collation.some((c) => c.cmp === 0)).toBe(true)
  })
})
