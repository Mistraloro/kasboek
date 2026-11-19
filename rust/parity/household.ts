// A seeded household for the list / filter / paging / totals checks: accounts in three currencies, categories, rules,
// exchange rates, about 2,000 transactions, splits, some edits and deletes, then many list calls (filters, search, paging).
// Everything is invented: the merchants are made up and the IBANs are well-known documentation examples.
import type { Scenario, Step } from './scenario-runner'

/** mulberry32: a small seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MERCHANTS = [
  'Albert Heijn Utrecht', 'DELHAIZE BRUSSEL', 'Colruyt Gent', 'Shell Station 12', 'Netflix.com', 'Spotify AB', 'Café Zürich', 'Boulangerie Éclair',
  'Bakkerij De Gouden Korst', 'Pharmacie Centrale', 'Apotheek Noord', 'IKEA Zaventem', 'Decathlon 100% Sport', 'Snack_Bar Ole', 'Tuin & Co', 'Vet Clinic Paws',
  'Energie Plus', 'Water Utility', 'Rent November', 'Mobile Phone Co', 'Cinema Royal', 'Book Shop Ñandú', 'Taxi Ghent', 'Parking Q-Park', 'Gift Corner',
  'Online Mart', 'Gym Club', 'Insurance Mutual', 'Tax Office', 'Bank Fees', 'École du Soir', 'Salary Acme Ltd', 'Side Gig Invoice', 'Refund Shop'
]

export function household(seed: number): Scenario {
  const rand = rng(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)]!
  const steps: Step[] = []
  const add = (op: string, input?: unknown, actor?: Step['actor']): void => void steps.push({ op, input, actor })

  const accounts = [
    { name: 'Checking', bank: 'Invented Bank', iban: 'BE68 5390 0754 7034', currency: 'EUR', openingBalanceCents: 120_000, bankBalance: { date: '2026-01-31', cents: 250_000 } },
    { name: 'Savings', bank: 'Invented Bank', iban: 'BE71096123456769', currency: 'EUR', kind: 'savings', openingBalanceCents: 500_000 },
    { name: 'Travel USD', bank: 'Dollar Co', iban: 'GB29NWBK60161331926819', currency: 'USD', fxCostPct: 1.5 },
    { name: 'Pound GBP', bank: 'Sterling Co', currency: 'GBP', openingBalanceCents: 10_000 },
    { name: 'Wallet', bank: '', currency: 'EUR', kind: 'cash' }
  ]
  accounts.forEach((a) => add('accounts.create', a))
  for (const [name, kind] of [['Pets', 'expense'], ['Hobby', 'expense'], ['Kids', 'expense'], ['Garden', 'expense'], ['Side income', 'income'], ['Holiday fund', 'transfer']] as const) add('categories.create', { name, kind })
  add('categories.update', { id: 20, archived: true })
  // Rules (the rules operations are not ported yet, so they are inserted as rows): contains, word, starts, iban.
  add('@sql', {
    sql: `INSERT INTO rules (field, pattern, category_id, match, priority) VALUES
      ('counterparty', 'delhaize', 3, 'contains', 0), ('any', 'shell', 6, 'contains', 0), ('description', 'netflix', 11, 'word', 0),
      ('any', 'spotify', 11, 'starts', 0), ('counterparty', 'albert', 3, 'starts', 5), ('any', 'cafe', 7, 'contains', 0),
      ('iban', 'BE62510007547061', 15, 'contains', 0), ('any', 'ikea', 8, 'word', 1)`
  })
  // Exchange rates: bank rates over two years, and a few typed in by hand.
  const rates: string[] = []
  for (let m = 0; m < 24; m++) {
    const date = `${2025 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`
    rates.push(`('USD', '${date}', ${(1.05 + m * 0.004).toFixed(4)}, 'ecb')`, `('GBP', '${date}', ${(0.84 + m * 0.002).toFixed(4)}, 'ecb')`)
  }
  rates.push("('USD', '2025-06-01', 1.2, 'manual')", "('GBP', '2026-03-01', 0.9, 'manual')")
  add('@sql', { sql: `INSERT INTO fx_rates (currency, date, per_eur, source) VALUES ${rates.join(',')}` })
  add('@fxReload')

  const total = 2000
  const amounts: number[] = []
  for (let i = 0; i < total; i++) {
    const account = rand() < 0.55 ? 1 : rand() < 0.4 ? 2 : rand() < 0.5 ? 3 : rand() < 0.6 ? 4 : 5
    const day = new Date(Date.UTC(2025, 0, 1) + int(0, 682) * 86_400_000).toISOString().slice(0, 10)
    const income = rand() < 0.12
    const cents = (income ? 1 : -1) * (rand() < 0.1 ? int(20_000, 400_000) : int(50, 15_000))
    amounts.push(cents)
    const merchant = pick(MERCHANTS)
    const input: Record<string, unknown> = { accountId: account, bookingDate: day, amountCents: cents, description: `${merchant} ref ${int(1000, 9999)}` }
    if (rand() < 0.7) input.counterpartyName = merchant
    const c = rand()
    if (c < 0.4) input.categoryId = int(1, 22)
    else if (c < 0.45) input.categoryId = null
    if (rand() < 0.1) input.notes = pick(['holiday', '50% off', 'check later', 'under_score'])
    add('transactions.create', input)
  }
  // Ids are 1..total in creation order. Splits over two or three categories that add up to the amount.
  for (let n = 0; n < 60; n++) {
    const id = int(1, total)
    const sum = amounts[id - 1]!
    const first = Math.trunc(sum / 3)
    const parts = rand() < 0.5 ? [first, sum - first] : [first, first, sum - 2 * first]
    add('transactions.split', { id, parts: parts.map((p, i) => ({ categoryId: i === 0 ? null : int(1, 18), amountCents: p, note: i === 1 ? 'part' : undefined })) })
  }
  for (let n = 0; n < 20; n++) {
    add('transactions.categorize', { ids: Array.from({ length: int(1, 8) }, () => int(1, total + 5)), categoryId: rand() < 0.2 ? null : int(1, 18) })
    add('transactions.rename', { ids: Array.from({ length: int(1, 5) }, () => int(1, total)), counterpartyName: `  Renamed ${int(1, 5)}  ` })
    add('transactions.edit', { id: int(1, total), notes: rand() < 0.5 ? null : 'edited', description: `Edited ${int(1, 99)}` })
    add('transactions.update', { id: int(1, total), bookingDate: `2026-0${int(1, 9)}-1${int(0, 9)}`, amountCents: -int(100, 9_999) })
  }
  add('transactions.delete', { ids: Array.from({ length: 40 }, () => int(1, total + 10)) })
  add('accounts.list')
  add('fx.status')

  // Lists: the whole set paged, and many filter combinations.
  for (let offset = 0; offset < 2100; offset += 500) add('transactions.list', { limit: 500, offset })
  add('transactions.list', {})
  const filters: Record<string, unknown>[] = []
  const searches = ['albert', 'SHELL', '%', '_', '100%', 'ref 1', 'école', 'ÉCOLE', 'under_score', 'zzz', '  netflix  ', 'Renamed', 'edited', 'Ñ', 'a']
  for (let n = 0; n < 160; n++) {
    const f: Record<string, unknown> = {}
    if (rand() < 0.35) f.accountId = int(1, 5)
    if (rand() < 0.3) f.categoryId = rand() < 0.3 ? 'none' : int(1, 22)
    const r = rand()
    if (r < 0.25) f.month = `${pick([2025, 2026])}-${String(int(1, 12)).padStart(2, '0')}`
    else if (r < 0.5) {
      f.from = `${pick([2025, 2026])}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
      if (rand() < 0.7) f.to = `2026-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
    }
    if (rand() < 0.2) f.search = pick(searches)
    if (rand() < 0.3) f.direction = pick(['in', 'out'])
    f.limit = pick([1, 7, 25, 100, 500])
    f.offset = pick([0, 0, 3, 40, 1990])
    filters.push(f)
  }
  filters.forEach((f) => add('transactions.list', f))
  // A filter paged to its end (every page and the totals).
  for (const base of [{ accountId: 1 }, { categoryId: 'none' }, { direction: 'out', month: '2026-03' }, { search: 'shop' }]) {
    for (let offset = 0; offset < 700; offset += 100) add('transactions.list', { ...base, limit: 100, offset })
  }
  // Splits of a few listed rows.
  for (let id = 1; id <= 12; id++) add('transactions.splits', { id })

  return { name: `household-${seed}`, clock: '2026-11-14T10:00:00Z', steps }
}
