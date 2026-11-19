// Invented household for the README screenshots. Everything here is made up: names, shops, IBANs
// (documentation-style examples), amounts. The generator is deterministic (seeded), so a re-run
// gives the same pictures. Dates are relative to TODAY, the fixed clock used by take.mjs.
//
// buildData() returns the answers the stubbed `window.kasboek` bridge gives, see bridge.mjs.

export const TODAY = '2026-11-15'
const THIS_MONTH = '2026-11'
const FIRST_MONTH = '2025-10'

// ---------- small helpers ----------
const rng = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rand = rng(20261115)
const pick = (list) => list[Math.floor(rand() * list.length)]
const between = (a, b) => a + rand() * (b - a)
const cents = (eur) => Math.round(eur * 100)
const pad = (n) => String(n).padStart(2, '0')
const months = []
for (let y = 2025, m = 10; `${y}-${pad(m)}` <= THIS_MONTH; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${pad(m)}`)
const addMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
const daysIn = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()
const day = (month, d) => `${month}-${pad(Math.min(d, daysIn(month)))}`

/** `n` amounts (cents) that add up to exactly `total`, uneven like real shopping. */
const spread = (total, n) => {
  const w = Array.from({ length: n }, () => 0.35 + rand())
  const sum = w.reduce((a, b) => a + b, 0)
  const parts = w.map((x) => Math.round((x / sum) * total))
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0)
  return parts
}

// ---------- accounts and categories ----------
const ACCOUNTS = [
  { id: 1, name: 'Everyday account', kind: 'current', bank: 'Example Bank', iban: 'BE68 5390 0754 7034', openingBalanceCents: 0 },
  { id: 2, name: 'Savings', kind: 'savings', bank: 'Example Bank', iban: 'BE71 0961 2345 6769', openingBalanceCents: cents(7200) },
  { id: 3, name: 'Visa card', kind: 'credit_card', bank: 'Example Bank', iban: null, openingBalanceCents: -cents(412.6) }
]
const acct = (id) => ACCOUNTS.find((a) => a.id === id)

const CATEGORY_LIST = [
  ['Groceries', 'expense', '#5b8c5a'],
  ['Rent', 'expense', '#8a6f4d'],
  ['Energy & water', 'expense', '#d9a441'],
  ['Internet & phone', 'expense', '#4f7cac'],
  ['Insurance', 'expense', '#7a6aa5'],
  ['Transport', 'expense', '#3f8f8b'],
  ['Dining out', 'expense', '#c8643c'],
  ['Leisure', 'expense', '#b25c8a'],
  ['Health', 'expense', '#d0605e'],
  ['Clothing', 'expense', '#8b7d5c'],
  ['Home', 'expense', '#6c8a9e'],
  ['Subscriptions', 'expense', '#9a6fb0'],
  ['Holidays', 'expense', '#2f9e8f'],
  ['Gifts', 'expense', '#c9798f'],
  ['Salary', 'income', '#4a9d6f'],
  ['Other income', 'income', '#7fb069'],
  ['Savings transfer', 'transfer', '#8c8c8c'],
  ['Card payment', 'transfer', '#a0a0a0']
]
const CATEGORIES = CATEGORY_LIST.map(([name, kind, color], i) => ({ id: i + 1, name, kind, parentId: null, color, sortOrder: i, archived: false }))
const cat = (name) => CATEGORIES.find((c) => c.name === name).id

// ---------- transactions ----------
const txs = []
const add = (accountId, date, amountCents, counterparty, description, category, extra = {}) => {
  txs.push({
    accountId,
    bookingDate: date,
    amountCents,
    counterpartyName: counterparty,
    description,
    categoryId: category ? cat(category) : null,
    counterpartyIban: null,
    communication: null,
    notes: null,
    transferAccount: null,
    ...extra
  })
}

const IBAN = {
  landlord: 'BE05 0123 4567 8910',
  employer: 'BE17 7330 0011 2233',
  energy: 'BE29 0018 2345 6789'
}

const SHOPS = ['Fresco Supermarkt', 'Fresco Supermarkt', 'Fresco Supermarkt', 'Marktkorf Express', 'Bakkerij De Gouden Korst', 'Slagerij Janssens', 'Groentehof Linde', 'Biowinkel Groene Vork']
const EATERIES = ['Café De Haven', 'Pizzeria Bella Napoli', 'Sushi Kobe', 'Brasserie Het Hoekje', 'Frituur Nonkel Jef', 'Koffiebar Bonsai']
const FUEL = ['Fuel Express', 'Pumpstation Noord']
const LEISURE = ['Cinema Rex', 'Boekhandel Pagina', 'Zwembad De Golf', 'Speelgoed & Spel Dobbel', 'Concertzaal De Kluis']
const CLOTHES = ['Moda Straat', 'Schoenhuis Voet', 'Kledingwinkel Lijn 12']
const HOME = ['Bouwmarkt Hamer & Zo', 'Tuincentrum Bloei', 'Woonwinkel Nest']
const HEALTH = ['Apotheek Linde', 'Tandartspraktijk Smile', 'Kine Bewegen']
const GIFTS = ['Cadeaushop Strik', 'Bloemen Roos']

const cardSpend = {} // month -> cents spent on the card, paid back on the 4th of the next month

for (const m of months) {
  const now = m === THIS_MONTH
  const last = now ? 15 : 31
  const mo = Number(m.slice(5))
  const upTo = (d) => d <= last

  // Fixed items, checking account
  if (upTo(1)) add(1, day(m, 1), -cents(950), 'Residentie Lindenhof', `STANDING ORDER RENT ${m}`, 'Rent', { counterpartyIban: IBAN.landlord })
  if (upTo(5)) add(1, day(m, 5), -cents(m >= '2026-11' ? 132 : 118), 'Voltra Energie', `VOLTRA ENERGIE ADVANCE ${m}`, 'Energy & water', { counterpartyIban: IBAN.energy })
  if (upTo(8)) add(1, day(m, 8), -cents(54.9), 'Netlink Internet', `NETLINK INTERNET ${m}`, 'Internet & phone')
  if (upTo(9)) add(1, day(m, 9), -cents(29.99), 'Telenova Mobile', `TELENOVA MOBILE ${m}`, 'Internet & phone')
  if (upTo(10)) add(1, day(m, 10), -cents(34.5), 'Ardenne Verzekeringen', `HOME INSURANCE ${m}`, 'Insurance')
  if (upTo(3)) add(1, day(m, 3), -cents(29.9), 'FitPlus Club', `FITPLUS MEMBERSHIP ${m}`, 'Health')
  if ([1, 4, 7, 10].includes(mo) && upTo(12)) add(1, day(m, 12), -cents(86.5), 'Waterbedrijf Kust', `WATER INVOICE Q${Math.ceil(mo / 3)}`, 'Energy & water')
  if (upTo(12)) add(1, day(m, 12), cents(2690), 'Northwind Logistics NV', `SALARY ${m}`, 'Salary', { counterpartyIban: IBAN.employer })
  if (upTo(13)) {
    add(1, day(m, 13), -cents(450), 'Savings', 'STANDING ORDER TO SAVINGS', 'Savings transfer', { transferAccount: 'Savings' })
    add(2, day(m, 13), cents(450), 'Everyday account', 'FROM EVERYDAY ACCOUNT', 'Savings transfer', { transferAccount: 'Everyday account' })
  }
  if (m === '2026-03') add(1, day(m, 18), -cents(612.4), 'Ardenne Verzekeringen', 'CAR INSURANCE ANNUAL PREMIUM', 'Insurance')
  if (mo % 3 === 0 && upTo(20)) add(2, day(m, 20), cents(Math.round(between(8, 12) * 100) / 100), 'Example Bank', 'INTEREST', 'Other income')
  if (!now && rand() < 0.45) add(1, day(m, 21), cents(Math.round(between(18, 95))), 'Mutualiteit Zuid', 'REIMBURSEMENT CLAIM', 'Other income')

  // Card: subscriptions
  if (upTo(14)) add(3, day(m, 14), -cents(m >= '2026-11' ? 15.99 : 13.99), 'StreamBox', 'STREAMBOX SUBSCRIPTION', 'Subscriptions')
  if (upTo(16)) add(3, day(m, 16), -cents(10.99), 'Melodia Music', 'MELODIA PREMIUM', 'Subscriptions')
  if (upTo(20)) add(3, day(m, 20), -cents(2.99), 'CloudVault', 'CLOUDVAULT 200 GB', 'Subscriptions')

  // Variable spending (this month stops on the 15th; the numbers are chosen so some budgets are tight)
  const t = (full, partial) => cents(now ? partial : Math.round(full * between(0.88, 1.12)))
  const n = (full, partial) => (now ? partial : full)
  const dayOf = () => Math.min(last, 1 + Math.floor(rand() * (now ? 14 : 28)))

  spread(t(430, 392), n(26, 11)).forEach((a) => add(1, day(m, dayOf()), -a, pick(SHOPS), 'DEBIT CARD PURCHASE', 'Groceries'))
  spread(t(165, 71), n(5, 3)).forEach((a) => add(1, day(m, dayOf()), -a, pick(FUEL), 'FUEL', 'Transport'))
  add(1, day(m, 2), -cents(51.5), 'Rail Pass NMB', 'MONTHLY RAIL PASS', 'Transport')
  spread(t(88, 174), n(8, 5)).forEach((a) => add(3, day(m, dayOf()), -a, pick(EATERIES), 'CARD PAYMENT', 'Dining out'))
  spread(t(72, 70), n(5, 3)).forEach((a) => add(3, day(m, dayOf()), -a, pick(LEISURE), 'CARD PAYMENT', 'Leisure'))
  spread(t(34, 22), n(3, 1)).forEach((a) => add(1, day(m, dayOf()), -a, pick(HEALTH), 'PHARMACY / CARE', 'Health'))
  if (rand() < 0.55 || m === '2026-11') spread(t(64, 58), 1 + Math.floor(rand() * 2)).forEach((a) => add(3, day(m, dayOf()), -a, pick(CLOTHES), 'CARD PAYMENT', 'Clothing'))
  if (rand() < 0.6) spread(t(52, 41), 1 + Math.floor(rand() * 2)).forEach((a) => add(1, day(m, dayOf()), -a, pick(HOME), 'DEBIT CARD PURCHASE', 'Home'))
  if (mo === 12) spread(cents(190), 4).forEach((a) => add(3, day(m, 5 + Math.floor(rand() * 15)), -a, pick(GIFTS), 'CARD PAYMENT', 'Gifts'))
  else if (rand() < 0.3) add(3, day(m, dayOf()), -cents(Math.round(between(20, 45))), pick(GIFTS), 'CARD PAYMENT', 'Gifts')
  if (m === '2026-06') add(3, day(m, 9), -cents(640), 'Sunway Reizen', 'HOLIDAY BOOKING COASTAL VILLA', 'Holidays')
  if (m === '2026-08') {
    add(3, day(m, 4), -cents(412), 'Sunway Reizen', 'HOLIDAY BALANCE PAYMENT', 'Holidays')
    spread(cents(386), 5).forEach((a) => add(3, day(m, 6 + Math.floor(rand() * 8)), -a, pick(['Taverna Aegean', 'Cafe Marina', 'Ice Cream Gelato Sol']), 'CARD PAYMENT ABROAD', 'Holidays'))
  }
  // The odd payment no rule has caught yet (older months only: the Overview stays tidy)
  if (now) {
    add(1, day(m, 11), -cents(23.4), 'Sport & Co', 'DEBIT CARD PURCHASE', 'Leisure')
    add(3, day(m, 13), -cents(18.9), 'Kwikfix', 'CARD PAYMENT', 'Home')
  } else if (rand() < 0.15) add(1, day(m, dayOf()), -cents(40), 'Cash machine Main Street', 'CASH WITHDRAWAL', null)
}

// The card bill: last month's card spending leaves the checking account on the 4th.
const cardOf = (m) => -txs.filter((x) => x.accountId === 3 && x.bookingDate.startsWith(m) && x.amountCents < 0 && x.categoryId !== cat('Card payment')).reduce((a, x) => a + x.amountCents, 0)
for (const m of months) {
  const settlement = m === FIRST_MONTH ? cents(412.6) : cardOf(addMonth(m, -1))
  const date = day(m, 4)
  add(1, date, -settlement, 'Visa card', 'VISA CARD STATEMENT', 'Card payment', { transferAccount: 'Visa card' })
  add(3, date, settlement, 'Everyday account', 'PAYMENT RECEIVED THANK YOU', 'Card payment', { transferAccount: 'Everyday account' })
}

// Order, ids, balances
txs.sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : a.amountCents - b.amountCents))
txs.forEach((x, i) => {
  x.id = i + 1
  x.accountName = acct(x.accountId).name
  x.valueDate = x.bookingDate
  x.currency = 'EUR'
  x.categoryName = x.categoryId ? CATEGORIES.find((c) => c.id === x.categoryId).name : null
  x.importBatchId = null
  x.splitCount = 0
})
// Checking opening balance chosen so today's balance is a believable figure.
const sumOf = (id) => txs.filter((x) => x.accountId === id).reduce((a, x) => a + x.amountCents, 0)
acct(1).openingBalanceCents = cents(1985.4) - sumOf(1)
const balanceOf = (id, upTo = '9999') => acct(id).openingBalanceCents + txs.filter((x) => x.accountId === id && x.bookingDate <= upTo).reduce((a, x) => a + x.amountCents, 0)

const accounts = ACCOUNTS.map((a) => ({
  ...a,
  currency: 'EUR',
  archived: false,
  createdAt: '2025-10-01',
  fxCostPct: null,
  lastBankBalance: a.id === 3 ? null : { date: '2026-11-14', balanceCents: balanceOf(a.id), differenceCents: 0 },
  balanceCents: balanceOf(a.id),
  balanceMainCents: balanceOf(a.id),
  transactionCount: txs.filter((x) => x.accountId === a.id).length
}))

// ---------- month and year summaries ----------
const isSpending = (x) => x.categoryId && CATEGORIES.find((c) => c.id === x.categoryId).kind === 'expense'
const isIncome = (x) => x.categoryId && CATEGORIES.find((c) => c.id === x.categoryId).kind === 'income'
const inMonth = (m) => txs.filter((x) => x.bookingDate.startsWith(m))
const spendingOf = (m) => inMonth(m).filter(isSpending).reduce((a, x) => a - x.amountCents, 0)
const incomeOf = (m) => inMonth(m).filter(isIncome).reduce((a, x) => a + x.amountCents, 0)

const BUDGETS = { Groceries: 450, 'Dining out': 120, Transport: 150, Leisure: 110, Health: 70, Clothing: 80, Home: 80, Subscriptions: 35, Gifts: 40 }
const budgetRows = (m) =>
  CATEGORIES.filter((c) => c.kind === 'expense').map((c) => ({
    categoryId: c.id,
    name: c.name,
    budgetCents: BUDGETS[c.name] ? cents(BUDGETS[c.name]) : null,
    spentCents: inMonth(m).filter((x) => x.categoryId === c.id).reduce((a, x) => a - x.amountCents, 0)
  }))

const summaryMonth = {}
for (const m of months) {
  const rows = budgetRows(m)
  const budgeted = rows.reduce((a, r) => a + (r.budgetCents ?? 0), 0)
  const budgetedSpent = rows.filter((r) => r.budgetCents !== null).reduce((a, r) => a + r.spentCents, 0)
  const byCategory = rows
    .filter((r) => r.spentCents > 0)
    .map((r) => ({ categoryId: r.categoryId, name: r.name, cents: r.spentCents }))
    .sort((a, b) => b.cents - a.cents)
  const uncategorized = inMonth(m).filter((x) => !x.categoryId).length
  summaryMonth[m] = {
    month: m,
    incomeCents: incomeOf(m),
    spendingCents: spendingOf(m),
    budgetedCents: budgeted,
    leftCents: budgeted - budgetedSpent,
    byCategory: uncategorized ? [...byCategory, { categoryId: null, name: 'Uncategorised', cents: inMonth(m).filter((x) => !x.categoryId).reduce((a, x) => a - x.amountCents, 0) }].sort((a, b) => b.cents - a.cents) : byCategory,
    uncategorized,
    unconverted: 0,
    history: months
      .filter((h) => h <= m && h >= addMonth(m, -5))
      .map((h) => ({ month: h, incomeCents: incomeOf(h), spendingCents: spendingOf(h) }))
  }
}
const budgets = Object.fromEntries(months.map((m) => [m, budgetRows(m)]))

const yearSummary = {}
for (const year of [2025, 2026]) {
  const ms = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`)
  const cats = CATEGORIES.filter((c) => c.kind !== 'transfer')
    .map((c) => {
      const perMonth = ms.map((m) => inMonth(m).filter((x) => x.categoryId === c.id).reduce((a, x) => a + (c.kind === 'expense' ? -x.amountCents : x.amountCents), 0))
      return { categoryId: c.id, name: c.name, kind: c.kind, months: perMonth, totalCents: perMonth.reduce((a, b) => a + b, 0) }
    })
    .filter((c) => c.totalCents > 0)
  yearSummary[year] = {
    year,
    months: ms.map((m) => ({ month: m, incomeCents: incomeOf(m), spendingCents: spendingOf(m) })),
    categories: cats,
    incomeCents: ms.reduce((a, m) => a + incomeOf(m), 0),
    spendingCents: ms.reduce((a, m) => a + spendingOf(m), 0),
    budgetedCents: ms.filter((m) => m >= FIRST_MONTH && m <= THIS_MONTH).reduce((a, m) => a + summaryMonth[m].budgetedCents, 0),
    years: []
  }
}
const years = [2025, 2026].map((y) => ({ year: y, incomeCents: yearSummary[y].incomeCents, spendingCents: yearSummary[y].spendingCents }))
for (const y of Object.values(yearSummary)) y.years = years

// ---------- net worth ----------
const history = months.map((m) => {
  const end = m === THIS_MONTH ? TODAY : day(m, 31)
  return { month: m, cents: [1, 2, 3].reduce((a, id) => a + balanceOf(id, end), 0), unconverted: 0 }
})
const nwAccounts = accounts.map((a) => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  currency: 'EUR',
  archived: false,
  valueCents: a.balanceCents,
  valueMainCents: a.balanceCents,
  investedCents: null,
  gainCents: null,
  lastValuation: null
}))
const netWorth = {
  main: 'EUR',
  totalCents: accounts.reduce((a, x) => a + x.balanceCents, 0),
  assetsCents: accounts.filter((a) => a.balanceCents > 0).reduce((a, x) => a + x.balanceCents, 0),
  liabilitiesCents: -accounts.filter((a) => a.balanceCents < 0).reduce((a, x) => a + x.balanceCents, 0),
  unconverted: 0,
  accounts: nwAccounts,
  history,
  firstMonth: FIRST_MONTH
}

// ---------- fixed costs ----------
const FIXED = [
  ['Residentie Lindenhof', 'out', 'monthly', 1, 'Rent', 1],
  ['Voltra Energie', 'out', 'monthly', 5, 'Energy & water', 1],
  ['Netlink Internet', 'out', 'monthly', 8, 'Internet & phone', 1],
  ['Telenova Mobile', 'out', 'monthly', 9, 'Internet & phone', 1],
  ['Ardenne Verzekeringen', 'out', 'monthly', 10, 'Insurance', 1],
  ['FitPlus Club', 'out', 'monthly', 3, 'Health', 1],
  ['Waterbedrijf Kust', 'out', 'quarterly', 12, 'Energy & water', 1],
  ['StreamBox', 'out', 'monthly', 14, 'Subscriptions', 3],
  ['Melodia Music', 'out', 'monthly', 16, 'Subscriptions', 3],
  ['CloudVault', 'out', 'monthly', 20, 'Subscriptions', 3],
  ['Northwind Logistics NV', 'in', 'monthly', 12, 'Salary', 1]
]
const recurringItems = FIXED.map(([name, direction, frequency, d, category, accountId]) => {
  const own = txs.filter((x) => x.counterpartyName === name && (name !== 'Ardenne Verzekeringen' || x.description.startsWith('HOME INSURANCE')))
  const lastTx = own.at(-1)
  const prev = own.at(-2)
  const typical = lastTx.amountCents
  const paidThisMonth = lastTx.bookingDate.startsWith(THIS_MONTH)
  const step = frequency === 'quarterly' ? 3 : 1
  const next = day(addMonth(lastTx.bookingDate.slice(0, 7), step), d)
  const status = paidThisMonth ? 'paid' : next.startsWith(THIS_MONTH) ? (next > TODAY ? 'due' : 'late') : 'later'
  return {
    key: `${direction}:${name.toLowerCase()}`,
    name,
    direction,
    frequency,
    typicalCents: typical,
    monthlyCents: Math.round(typical / step),
    lastCents: typical,
    lastDate: lastTx.bookingDate,
    nextDate: next,
    count: own.length,
    status,
    priceChangeCents: prev && prev.amountCents !== typical ? typical - prev.amountCents : null,
    categoryId: cat(category),
    categoryName: category,
    accountId,
    accountName: acct(accountId).name,
    transactionIds: own.slice(-6).map((x) => x.id)
  }
})
const recurring = {
  items: recurringItems,
  hidden: [],
  monthlyOutCents: -recurringItems.filter((i) => i.direction === 'out').reduce((a, i) => a + i.monthlyCents, 0),
  monthlyInCents: recurringItems.filter((i) => i.direction === 'in').reduce((a, i) => a + i.monthlyCents, 0),
  dueThisMonthCents: -recurringItems.filter((i) => i.status === 'due' || i.status === 'late').reduce((a, i) => a + i.typicalCents, 0)
}

// ---------- goals ----------
const monthsUntil = (date) => (Number(date.slice(0, 4)) - 2026) * 12 + Number(date.slice(5, 7)) - 11
const goal = (id, name, target, targetDate, accountId, saved) => {
  const current = accountId ? balanceOf(accountId) : cents(saved)
  const remaining = Math.max(0, cents(target) - current)
  return {
    id,
    name,
    targetCents: cents(target),
    targetDate,
    accountId,
    accountName: accountId ? acct(accountId).name : null,
    savedCents: accountId ? null : cents(saved),
    currentCents: current,
    remainingCents: remaining,
    reached: remaining === 0,
    perMonthCents: targetDate && remaining > 0 ? Math.ceil(remaining / Math.max(1, monthsUntil(targetDate))) : null,
    overdue: false,
    archived: false
  }
}
const goals = [
  goal(1, 'Emergency fund (6 months)', 15000, '2027-06-30', 2, 0),
  goal(2, 'Summer trip 2027', 3200, '2027-06-01', null, 1240),
  goal(3, 'New laptop', 1400, null, null, 1400),
  goal(4, 'Bike upgrade', 900, '2027-03-31', null, 310)
]

// ---------- tips on the Overview (local facts for November 2026) ----------
const nov = budgets[THIS_MONTH]
const rowOf = (name) => nov.find((r) => r.name === name)
const money = (c) => ({ money: c, currency: 'EUR' })
const dining = rowOf('Dining out')
const groceries = rowOf('Groceries')
const pct = (r) => Math.round((r.spentCents / r.budgetCents) * 100)
const avg3 = (name) => Math.round(['2026-08', '2026-09', '2026-10'].reduce((a, m) => a + budgets[m].find((r) => r.name === name).spentCents, 0) / 3)
const subs = recurringItems.filter((i) => i.categoryName === 'Subscriptions')
const insightFacts = [
  { id: 'f1', key: `over_budget:dining:${THIS_MONTH}`, kind: 'over_budget', values: { name: { text: 'Dining out' }, spent: money(dining.spentCents), budget: money(dining.budgetCents), percent: { count: pct(dining) }, month: { text: THIS_MONTH } }, categoryId: dining.categoryId, recurringKey: null, transactionIds: [], weight: 60000 },
  { id: 'f2', key: 'price_up:voltra', kind: 'price_up', values: { name: { text: 'Voltra Energie' }, from: money(11800), to: money(13200), change: money(1400), date: { date: '2026-11-05' } }, categoryId: cat('Energy & water'), recurringKey: 'out:voltra energie', transactionIds: [], weight: 50000 },
]

// ---------- the chat: "How much did I spend on groceries last month?" ----------
const octGroceries = txs.filter((x) => x.categoryId === cat('Groceries') && x.bookingDate.startsWith('2026-10'))
const octTotal = -octGroceries.reduce((a, x) => a + x.amountCents, 0)
const byShop = {}
for (const x of octGroceries) byShop[x.counterpartyName] = (byShop[x.counterpartyName] ?? 0) - x.amountCents
const topShop = Object.entries(byShop).sort((a, b) => b[1] - a[1])[0]
const eur = (c) => `€${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const groceriesAvg = avg3('Groceries')
const chat = [
  { id: 'm1', role: 'user', text: 'How much did I spend on groceries last month?' },
  {
    id: 'm2',
    role: 'assistant',
    tools: [
      { name: 'summary_month', ok: true },
      { name: 'transactions_list', ok: true }
    ],
    text:
      `In **October 2026** you spent **${eur(octTotal)}** on groceries, across ${octGroceries.length} purchases.\n\n` +
      `- The biggest share went to ${topShop[0]}: ${eur(topShop[1])}.\n` +
      `- That is ${eur(Math.abs(octTotal - groceriesAvg))} ${octTotal >= groceriesAvg ? 'more' : 'less'} than your average of ${eur(groceriesAvg)} for the three months before.\n` +
      `- Your budget is ${eur(cents(BUDGETS.Groceries))}, so you stayed ${octTotal <= cents(BUDGETS.Groceries) ? 'within' : 'over'} it.`
  },
  { id: 'm3', role: 'user', text: 'And how is November looking so far?' },
  {
    id: 'm4',
    role: 'assistant',
    tools: [{ name: 'budgets_list', ok: true }],
    text: `So far this month you are at **${eur(groceries.spentCents)}** of your ${eur(groceries.budgetCents)} grocery budget (${pct(groceries)}%), with half the month still to go. Dining out is already over its budget at ${eur(dining.spentCents)} of ${eur(dining.budgetCents)}.`
  }
]

// ---------- imports ----------
const importRow = (i, date, amount, payee, description, category, status = 'ready', extra = {}) => ({
  index: i,
  line: i + 2,
  bookingDate: date,
  amountCents: amount,
  description,
  counterpartyName: payee,
  counterpartyIban: null,
  communication: null,
  categoryId: category ? cat(category) : null,
  categorySource: category ? 'rule' : null,
  issues: [],
  status,
  decided: null,
  note: null,
  match: null,
  ...extra
})
const csvRows = [
  importRow(0, '2026-11-03', -cents(41.27), 'Fresco Supermarkt', 'DEBIT CARD PURCHASE FRESCO SUPERMARKT', 'Groceries'),
  importRow(1, '2026-11-03', -cents(29.9), 'FitPlus Club', 'FITPLUS MEMBERSHIP 2026-11', 'Health'),
  importRow(2, '2026-11-04', -cents(612.35), 'Visa card', 'VISA CARD STATEMENT', 'Card payment'),
  importRow(3, '2026-11-05', -cents(132), 'Voltra Energie', 'VOLTRA ENERGIE ADVANCE 2026-11', 'Energy & water'),
  importRow(4, '2026-11-06', -cents(40), 'Cash machine Main Street', 'CASH WITHDRAWAL', null),
  importRow(5, '2026-11-08', -cents(54.9), 'Netlink Internet', 'NETLINK INTERNET 2026-11', 'Internet & phone'),
  importRow(6, '2026-11-09', -cents(29.99), 'Telenova Mobile', 'TELENOVA MOBILE 2026-11', 'Internet & phone'),
  importRow(7, '2026-11-10', -cents(34.5), 'Ardenne Verzekeringen', 'HOME INSURANCE 2026-11', 'Insurance', 'duplicate', { match: { id: 861, bookingDate: '2026-11-10', counterpartyName: 'Ardenne Verzekeringen', description: 'HOME INSURANCE 2026-11' } }),
  importRow(8, '2026-11-11', -cents(23.4), 'Sport & Co', 'DEBIT CARD PURCHASE SPORT & CO', null),
  importRow(9, '2026-11-12', cents(2690), 'Northwind Logistics NV', 'SALARY 2026-11', 'Salary'),
  importRow(10, '2026-11-13', -cents(450), 'Savings', 'STANDING ORDER TO SAVINGS', 'Savings transfer')
]
const stats = (rows) => ({
  total: rows.length,
  ready: rows.filter((r) => r.status === 'ready').length,
  duplicates: rows.filter((r) => r.status === 'duplicate').length,
  possibleDuplicates: 0,
  problems: 0,
  skipped: 0,
  inCents: rows.filter((r) => r.status === 'ready' && r.amountCents > 0).reduce((a, r) => a + r.amountCents, 0),
  outCents: -rows.filter((r) => r.status === 'ready' && r.amountCents < 0).reduce((a, r) => a + r.amountCents, 0),
  from: rows[0].bookingDate,
  to: rows.at(-1).bookingDate,
  fileFrom: rows[0].bookingDate,
  fileTo: rows.at(-1).bookingDate
})
const csvImport = {
  sessionId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
  fileName: 'everyday-account-november.csv',
  accountId: 1,
  accountName: 'Everyday account',
  currency: 'EUR',
  layout: null,
  encoding: 'UTF-8',
  mappingSource: 'detected',
  headers: ['Booking date', 'Counterparty', 'Description', 'Amount', 'Currency'],
  sample: csvRows.slice(0, 4).map((r) => [r.bookingDate.split('-').reverse().join('/'), r.counterpartyName, r.description, (r.amountCents / 100).toFixed(2).replace('.', ','), 'EUR']),
  mapping: { delimiter: ';', headerRow: 0, dateOrder: 'DMY', decimal: ',', invertSign: false, columns: { bookingDate: 0, counterpartyName: 1, description: [2], amount: 3, currency: 4 } },
  rows: csvRows,
  stats: stats(csvRows),
  notes: [],
  edited: 0,
  check: null,
  fileKind: 'csv',
  pdf: null,
  xml: null
}
const pdfRows = [
  importRow(0, '2026-10-01', -cents(950), 'Residentie Lindenhof', 'STANDING ORDER RENT 2026-10', 'Rent'),
  importRow(1, '2026-10-05', -cents(132), 'Voltra Energie', 'VOLTRA ENERGIE ADVANCE 2026-10', 'Energy & water'),
  importRow(2, '2026-10-08', -cents(54.9), 'Netlink Internet', 'NETLINK INTERNET 2026-10', 'Internet & phone'),
  importRow(3, '2026-10-12', cents(2690), 'Northwind Logistics NV', 'SALARY 2026-10', 'Salary'),
  importRow(4, '2026-10-13', -cents(450), 'Savings', 'STANDING ORDER TO SAVINGS', 'Savings transfer'),
  importRow(5, '2026-10-17', -cents(63.18), 'Fresco Supermarkt', 'DEBIT CARD PURCHASE', 'Groceries'),
  importRow(6, '2026-10-21', -cents(38.4), 'Fuel Express', 'FUEL', 'Transport'),
  importRow(7, '2026-10-26', -cents(52.75), 'Marktkorf Express', 'DEBIT CARD PURCHASE', 'Groceries')
]
const pdfSum = pdfRows.reduce((a, r) => a + r.amountCents, 0)
const pdfImport = {
  ...csvImport,
  sessionId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  fileName: 'statement-october-2026.pdf',
  mappingSource: 'detected',
  headers: ['Date', 'Description', 'Amount'],
  sample: pdfRows.slice(0, 3).map((r) => [r.bookingDate, r.description, (r.amountCents / 100).toFixed(2)]),
  mapping: { delimiter: ',', headerRow: 0, dateOrder: 'YMD', decimal: '.', invertSign: false, columns: { bookingDate: 0, description: [1], amount: 2 } },
  rows: pdfRows,
  stats: stats(pdfRows),
  fileKind: 'pdf',
  pdf: {
    pages: 3,
    readBy: 'kasboek',
    tableFound: true,
    reconciliation: { openingCents: cents(2314.62), closingCents: cents(2314.62) + pdfSum, sumCents: pdfSum, differenceCents: 0, rowsChecked: pdfRows.length, runningMismatches: 0 },
    notes: []
  }
}

// ---------- settings ----------
const settings = {
  currency: 'EUR',
  fxAutoUpdate: false,
  fxLastEcbUpdateAt: null,
  autoBackupEnabled: true,
  autoBackupFolder: '~/Documents/Kasboek backups',
  autoBackupKeep: 7,
  lastBackupAt: '2026-11-14T20:15:00.000Z',
  lastBackupFile: 'kasboek-backup-2026-11-14.kasboekbak',
  chatModel: 'claude-sonnet-5-5',
  chatEffort: 'medium',
  csvModel: 'claude-haiku-5-5',
  csvEffort: 'low',
  mcpEnabled: false,
  aiProvider: 'anthropic',
  aiBaseUrl: null,
  aiChatModel: '',
  aiCsvModel: '',
  aiPdfModel: '',
  aiProviders: {},
  savedSearches: [
    { name: 'Oct groceries', filter: { categoryId: cat('Groceries'), month: '2026-10' } },
    { name: 'Dining out now', filter: { categoryId: cat('Dining out'), month: THIS_MONTH } }
  ],
  aiReasoning: 'medium',
  aiCsvReasoning: 'low',
  permissions: { mode: 'smart', rules: {}, mcpAlwaysAsk: true },
  memoryEnabled: true,
  pageContextEnabled: true,
  hideAccountNumbers: true,
  aiInsightsConsent: null,
  aiCheckConsent: null
}

const rules = [
  ['Fresco Supermarkt', 'Groceries'],
  ['Marktkorf', 'Groceries'],
  ['Voltra Energie', 'Energy & water'],
  ['Netlink', 'Internet & phone'],
  ['Telenova', 'Internet & phone'],
  ['Northwind Logistics', 'Salary'],
  ['Fuel Express', 'Transport'],
  ['Café De Haven', 'Dining out']
].map(([pattern, category], i) => ({ id: i + 1, field: 'counterparty', match: 'contains', pattern, categoryId: cat(category), categoryName: category, priority: i + 1 }))

export function buildData() {
  return {
    today: TODAY,
    transactions: [...txs].reverse(),
    answers: {
      'app.info': { name: 'Kasboek', version: '0.22.0', commit: '', platform: 'win32', dataDir: 'C:\\Users\\sam\\AppData\\Roaming\\Kasboek', graphics: { hardware: true, reason: null }, mcpCommand: { command: 'kasboek-mcp', args: [] } },
      'prefs.get': { theme: 'light', language: 'en', formats: { decimal: ',', group: '.', grouping: 'thousands', currencyPosition: 'before', currencyStyle: 'symbol', negative: 'minus', date: 'DD/MM/YYYY', time: '24h' }, autoLockMinutes: 10, updateCheck: false, welcomeDone: true, graphics: 'auto', graphicsFailed: false, keepInTray: false, insights: true },
      'auth.status': { state: 'unlocked', mode: 'password', twoFactor: false, rememberedUntil: null, device: null, deviceChecking: false, throttleSeconds: 0, recovered: false, weakPassword: false, legacyData: false, erased: [], keyProtection: 'os', error: null },
      'settings.get': settings,
      'backup.status': { autoEnabled: true, folder: settings.autoBackupFolder, keep: 7, lastBackupAt: settings.lastBackupAt, lastBackupFile: settings.lastBackupFile },
      'backup.list': [
        { name: 'kasboek-backup-2026-11-14.kasboekbak', createdAt: '2026-11-14T20:15:00.000Z', size: 1_482_240, tier: 'recent' },
        { name: 'kasboek-backup-2026-11-07.kasboekbak', createdAt: '2026-11-07T20:15:00.000Z', size: 1_470_112, tier: 'daily' },
        { name: 'kasboek-backup-2026-10-31.kasboekbak', createdAt: '2026-10-31T20:15:00.000Z', size: 1_455_872, tier: 'monthly' }
      ],
      'accounts.list': accounts,
      'categories.list': CATEGORIES,
      'alerts.list': [],
      'recurring.list': recurring,
      'goals.list': goals,
      'networth.summary': netWorth,
      'valuations.list': [],
      'balances.list': [],
      'rules.list': rules,
      'insights.get': { facts: insightFacts, ai: null },
      'insights.status': { running: false, month: null, startedAt: null },
      'assistant.status': { configured: true, keyHint: '…7Qk2', provider: 'anthropic', providerName: 'Claude', company: 'Anthropic', busy: false, activity: null, messages: chat },
      'assistant.models': [],
      'memory.list': {
        enabled: true,
        limit: 50,
        items: [
          { id: 1, text: 'Prefers short answers with the main number first.', source: 'person', createdAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z' },
          { id: 2, text: 'Saving towards a summer trip in 2027.', source: 'assistant', createdAt: '2026-10-20T18:30:00.000Z', updatedAt: '2026-10-20T18:30:00.000Z' }
        ]
      },
      'update.status': { state: 'none', current: '0.22.0', latest: null, notes: null, pageUrl: null, kind: null, sizeBytes: null, progress: 0, error: null, lastCheckedAt: null, supported: false },
      'sync.status': { state: 'off', folder: null, kind: null, devices: [], lastSyncAt: null, error: null, conflicts: [], busy: false },
      'fx.status': { main: 'EUR', currencies: [], lastEcbUpdateAt: null, autoUpdate: false },
      'fx.rates': [],
      'mcp.setupStatus': { entry: { command: 'kasboek-mcp', args: [] }, helperFound: true, desktop: null, code: null, devBuild: false, bridgeError: null },
      'mcp.clients': { desktop: null, code: null, other: null },
      'import.batches': [{ id: 3, fileName: 'everyday-account-october.csv', accountName: 'Everyday account', rowCount: 38, committedAt: '2026-11-01T18:42:00.000Z', remaining: 38 }],
      'import.current': null,
      'transfers.find': []
    },
    summaryMonth,
    budgets,
    yearSummary,
    imports: { csv: csvImport, pdf: pdfImport },
    stats: { transactions: txs.length, octoberGroceries: octTotal, balances: accounts.map((a) => a.balanceCents) }
  }
}
