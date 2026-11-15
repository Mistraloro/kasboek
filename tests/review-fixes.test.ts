import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@core/database'
import { analyze, applyCheckProposals, commit, getCheck, remap, setCheck, snapshot, undoCheck, updateRows } from '@core/import'
import { createRule, insertTransaction, listRules, matchRule, previewRule, reorderRules, textMatches, updateRule } from '@core/finance'
import { groupKey, parsePlan, rowGroups } from '@core/assist-plan'
import { realReference } from '@core/csv/normalize'
import { MIGRATIONS } from '@core/migrations'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, app: { getPath: () => tmpdir(), isPackaged: false } }))

function db() {
  const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-review-')), 'k.db'), randomBytes(32).toString('hex'))
  const acc = Number(d.prepare("INSERT INTO accounts (name) VALUES ('Main')").run().lastInsertRowid)
  return { d, acc }
}
const cat = (d: ReturnType<typeof db>['d'], name: string) => (d.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id
const csv = (lines: string[]) => new TextEncoder().encode(['Date;Payee;Memo;Amount;Reference', ...lines].join('\n'))
const MAPPING = { delimiter: ';', headerRow: 0, dateOrder: 'YMD', decimal: ',', invertSign: false, columns: { bookingDate: 0, counterpartyName: 1, description: [2], amount: 3, bankReference: 4 } } as const

function open(d: ReturnType<typeof db>['d'], acc: number, lines: string[]) {
  const p = analyze(d, { fileName: 'x.csv', bytes: csv(lines), accountId: acc })
  return remap(d, p.sessionId, MAPPING)
}

describe('rules', () => {
  it('matches anywhere, as a whole word or at the start, ignoring case and accents', () => {
    expect(textMatches('Betaling COLRUYT Brugge', 'colruyt', 'contains')).toBe(true)
    expect(textMatches('REF Q8X41', 'q8', 'word')).toBe(false)
    expect(textMatches('Tankstation Q8 Gent', 'q8', 'word')).toBe(true)
    expect(textMatches('Café Zénith', 'cafe', 'starts')).toBe(true)
    expect(textMatches('Le Café', 'cafe', 'starts')).toBe(false)
  })

  it('makes short texts whole-word rules, orders by priority, previews and updates', () => {
    const { d, acc } = db()
    const groceries = cat(d, 'Groceries')
    const transport = cat(d, 'Transport')
    for (const [cp, desc] of [['Q8 Gent', 'fuel'], ['Shop', 'REF Q8X41'], ['Delhaize', 'shopping']] as const)
      insertTransaction(d, { accountId: acc, bookingDate: '2026-10-01', amountCents: -1000, description: desc, counterpartyName: cp })
    const short = createRule(d, { field: 'any', pattern: 'Q8', categoryId: transport, applyToExisting: true })
    expect(short.rule.match).toBe('word')
    expect(short.applied).toBe(1)
    const p = previewRule(d, { field: 'any', pattern: 'delhaize', categoryId: groceries })
    expect(p).toMatchObject({ matches: 1, uncategorised: 1, otherCategory: 0, wholeWord: false })
    const a = createRule(d, { field: 'description', pattern: 'shopping', categoryId: groceries, applyToExisting: false }).rule
    const b = createRule(d, { field: 'counterparty', pattern: 'delh', categoryId: transport, applyToExisting: false }).rule
    // Counterparty rules come before description rules of the same priority.
    expect(matchRule(d, { counterpartyName: 'Delhaize', description: 'shopping' })?.id).toBe(b.id)
    reorderRules(d, [a.id])
    expect(matchRule(d, { counterpartyName: 'Delhaize', description: 'shopping' })?.id).toBe(a.id)
    expect(listRules(d)[0]!.id).toBe(a.id)
    const u = updateRule(d, { id: b.id, pattern: 'Delhaize', categoryId: groceries, applyToExisting: true })
    expect(u.rule).toMatchObject({ pattern: 'Delhaize', categoryId: groceries })
    expect(u.applied).toBe(1)
  })
})

describe('duplicates', () => {
  it('uses a bank reference that is unique in the file, whatever the text says now', () => {
    const { d, acc } = db()
    commit(d, open(d, acc, ['2026-10-01;Shop;Old wording;-12,00;REF123']).sessionId, false)
    const p = open(d, acc, ['2026-10-01;Shop;New wording of the bank;-12,00;REF123'])
    expect(p.rows[0]!.status).toBe('duplicate')
    expect(p.rows[0]!.match?.description).toBe('Old wording')
  })

  it('flags the same amount a day later with similar text as a possible duplicate', () => {
    const { d, acc } = db()
    commit(d, open(d, acc, ['2026-10-01;Delhaize Brugge;Kaartbetaling Delhaize Brugge;-23,40;']).sessionId, false)
    const p = open(d, acc, ['2026-10-02;Delhaize Brugge;Betaling Delhaize Brugge 02/10;-23,40;', '2026-10-02;Other shop;Something else;-23,40;'])
    expect(p.rows.map((r) => r.status)).toEqual(['possible_duplicate', 'ready'])
    expect(p.stats.possibleDuplicates).toBe(1)
    // The person (or Check) can still include it.
    expect(updateRows(d, p.sessionId, [{ index: 0, decided: 'include' }]).rows[0]!.status).toBe('ready')
  })

  it('treats a second identical coffee as new when the account has one', () => {
    const { d, acc } = db()
    commit(d, open(d, acc, ['2026-10-01;Bar;Coffee;-2,50;']).sessionId, false)
    const p = open(d, acc, ['2026-10-01;Bar;Coffee;-2,50;', '2026-10-01;Bar;Coffee;-2,50;'])
    expect(p.rows.map((r) => r.status)).toEqual(['duplicate', 'ready'])
  })

  it('ignores a reference that repeats in the file (a statement number)', () => {
    const { d, acc } = db()
    commit(d, open(d, acc, ['2026-10-01;A;First;-1,00;STMT7']).sessionId, false)
    const p = open(d, acc, ['2026-10-05;B;Second;-5,00;STMT7', '2026-10-06;C;Third;-6,00;STMT7'])
    expect(p.rows.map((r) => r.status)).toEqual(['ready', 'ready'])
  })
})

describe('pending payments (review 14 #1)', () => {
  it('treats a placeholder reference as none', () => {
    for (const p of ['2026-', '2026', '', '-', '0', '000', ' 2026/ ']) expect(realReference(p)).toBeNull()
    for (const r of ['2026-00751', 'REF123', '20260001']) expect(realReference(r)).toBe(r)
  })

  it('recognises a pending row once the bank has given it a number', () => {
    const { d, acc } = db()
    commit(d, open(d, acc, ['2026-11-14;Shop;Betaling Shop Brugge;-71,15;2026-', '2026-11-14;Bar;Betaling Bar Gent;-1,20;2026-']).sessionId, false)
    expect((d.prepare('SELECT count(*) AS n FROM transactions WHERE bank_reference IS NULL').get() as { n: number }).n).toBe(2)
    // Same text: an exact duplicate. Slightly different text: a possible duplicate. Never ready.
    const p = open(d, acc, ['2026-11-14;Shop;Betaling Shop Brugge;-71,15;2026-00751', '2026-11-15;Bar;Betaling Bar Gent 14/11;-1,20;2026-00752'])
    expect(p.rows.map((r) => r.status)).toEqual(['duplicate', 'possible_duplicate'])
  })

  it('clears placeholder references already stored, and makes short rules whole-word', () => {
    const { d, acc } = db()
    d.prepare("INSERT INTO transactions (account_id, booking_date, amount_cents, currency, description, bank_reference, fingerprint) VALUES (?, '2026-11-14', -7115, 'EUR', 'x', '2026-', 'old')").run(acc)
    d.prepare("INSERT INTO rules (field, pattern, match, category_id) VALUES ('any', 'FOD', 'contains', ?)").run(cat(d, 'Groceries'))
    MIGRATIONS.at(-2)!(d)
    const t = d.prepare('SELECT bank_reference, fingerprint FROM transactions').get() as { bank_reference: string | null; fingerprint: string }
    expect(t.bank_reference).toBeNull()
    expect(t.fingerprint).not.toBe('old')
    expect(listRules(d)[0]!.match).toBe('word')
  })
})

describe('the bank’s own text (review 14 #4, #5)', () => {
  it('keeps the bank text, learns readable names, and rules on either keep working', () => {
    const { d, acc } = db()
    const groceries = cat(d, 'Groceries')
    const p = open(d, acc, ['2026-10-01;CRF MKT BRUGGE 8200;Betaling;-10,00;'])
    updateRows(d, p.sessionId, [{ index: 0, counterpartyName: 'Carrefour', description: 'Kaartbetaling' }])
    commit(d, p.sessionId, false)
    expect(d.prepare('SELECT counterparty_name, bank_counterparty, bank_description FROM transactions').get()).toEqual({ counterparty_name: 'Carrefour', bank_counterparty: 'CRF MKT BRUGGE 8200', bank_description: 'Betaling' })
    // A rule on the readable name, and its preview, see the stored transaction.
    expect(previewRule(d, { field: 'counterparty', pattern: 'Carrefour' }).matches).toBe(1)
    expect(previewRule(d, { field: 'counterparty', pattern: 'CRF MKT' }).matches).toBe(1)
    createRule(d, { field: 'counterparty', pattern: 'Carrefour', categoryId: groceries, applyToExisting: true })
    // The next raw import gets the learned name, so the rule fires without a check.
    const next = open(d, acc, ['2026-11-01;CRF MKT BRUGGE 8200;Betaling;-23,00;'])
    expect(next.rows[0]).toMatchObject({ counterpartyName: 'Carrefour', description: 'Kaartbetaling', categoryId: groceries, categorySource: 'rule' })
  })

  it('matches a rule on the counterparty account number', () => {
    const { d, acc } = db()
    const savings = cat(d, 'Savings')
    insertTransaction(d, { accountId: acc, bookingDate: '2026-10-01', amountCents: -5000, description: 'To savings', counterpartyName: 'Tim De Vos', counterpartyIban: 'BE68539007547034' })
    insertTransaction(d, { accountId: acc, bookingDate: '2026-10-02', amountCents: -2000, description: 'Revolut', counterpartyName: 'Tim De Vos', counterpartyIban: 'LT123250000000000001' })
    const r = createRule(d, { field: 'iban', pattern: 'be68 5390 0754 7034', categoryId: savings, applyToExisting: true })
    expect(r.rule.pattern).toBe('BE68539007547034')
    expect(r.applied).toBe(1)
  })

  it('splits transfers from one person by what each was for, not bills', () => {
    const row = (communication: string | null, iban: string | null = 'BE00111') => ({ counterpartyName: 'Jan Peeters', description: 'Overschrijving', amountCents: 500, communication, counterpartyIban: iban })
    expect(groupKey(row('Bijdrage Netflix'))).not.toBe(groupKey(row('Verkoop pc')))
    expect(groupKey(row('Bijdrage Netflix november'))).not.toBe(groupKey(row('Bijdrage Netflix')))
    expect(groupKey(row('+++090/9337/55493+++'))).toBe(groupKey(row(null)))
    expect(groupKey(row('Bijdrage Netflix', null))).toBe(groupKey(row(null, null)))
  })
})

describe('check results', () => {
  it('undoes one part, applies accepted proposals, and undoes everything', () => {
    const { d, acc } = db()
    const groceries = cat(d, 'Groceries')
    const old = insertTransaction(d, { accountId: acc, bookingDate: '2026-09-01', amountCents: -500, description: 'COLRUYT 123', counterpartyName: null })
    const p = open(d, acc, ['2026-10-01;COLRUYT BRUGGE;card;-10,00;', '2026-10-02;Bakker;bread;-3,00;'])
    const before = snapshot(p.sessionId)
    updateRows(d, p.sessionId, [
      { index: 0, categoryId: groceries, categorySource: 'assistant', counterpartyName: 'Colruyt' },
      { index: 1, decided: 'skip', note: 'test' }
    ])
    setCheck(p.sessionId, {
      summary: {
        by: 'Test',
        alreadyImported: 0,
        total: 2,
        mappingChanged: false,
        rules: [{ id: 1, field: 'any', match: 'contains', pattern: 'COLRUYT', categoryId: groceries, categoryName: 'Groceries', rowsHere: 1, existing: 1 }],
        existing: [{ id: 1, label: 'Colruyt', categoryId: groceries, categoryName: 'Groceries', count: 1, totalCents: -500 }],
        dropped: [],
        applied: null
      },
      before,
      parts: { categories: [0], names: [0], fixes: [1] },
      existingIds: new Map([[1, [old]]])
    })
    let q = undoCheck(d, p.sessionId, 'names')
    expect(q.rows[0]).toMatchObject({ counterpartyName: 'COLRUYT BRUGGE', categoryId: groceries })
    expect(q.check?.renamed).toBe(0)
    // Meanwhile one older transaction got a category by hand: Apply leaves it alone.
    const other = insertTransaction(d, { accountId: acc, bookingDate: '2026-09-02', amountCents: -700, description: 'COLRUYT 456', counterpartyName: null })
    const household = cat(d, 'Shopping')
    d.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(household, other)
    getCheck(p.sessionId)!.existingIds.set(1, [old, other])
    const applied = applyCheckProposals(d, p.sessionId, { rules: [1], existing: [1] })
    expect(applied.rules).toBe(1)
    expect(applied.skipped).toBe(1)
    expect((d.prepare('SELECT category_id FROM transactions WHERE id = ?').get(old) as { category_id: number }).category_id).toBe(groceries)
    expect((d.prepare('SELECT category_id FROM transactions WHERE id = ?').get(other) as { category_id: number }).category_id).toBe(household)
    expect(getCheck(p.sessionId)?.summary.rules).toEqual([])
    q = undoCheck(d, p.sessionId, 'all')
    expect(q.check).toBeNull()
    expect(q.rows[1]!.status).toBe('ready')
    // The rule stays (it was accepted), so the row is still categorised by it.
    expect(q.rows[0]).toMatchObject({ categoryId: groceries, categorySource: 'rule' })
  })

  it('groups new rows with uncategorised transactions already in Kasboek', () => {
    const { d, acc } = db()
    const p = open(d, acc, ['2026-10-01;Delhaize;card 1;-10,00;', '2026-10-03;Delhaize;card 2;-12,00;'])
    const groups = rowGroups(p.rows, [{ id: 9, bookingDate: '2026-09-01', amountCents: -8, counterpartyName: 'DELHAIZE', description: 'x' }])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ totalCents: -2208 })
    expect(groups[0]!.rows).toHaveLength(2)
    expect(groups[0]!.existing).toHaveLength(1)
  })

  it('reads rules from a plan, and an older plan without them', () => {
    const plan = parsePlan(JSON.stringify({ mapping: null, fixes: [], groups: [], rules: [{ group: '0', field: 'counterparty', pattern: 'Telenet', categoryId: 3 }], notes: [] }), 'X')
    expect(plan.rules).toEqual([{ group: 0, field: 'counterparty', match: 'contains', pattern: 'Telenet', categoryId: 3 }])
    expect(parsePlan(JSON.stringify({ mapping: null, fixes: [], groups: [], notes: ['ok'] }), 'X').rules).toEqual([])
  })
})

describe('assistant plumbing', () => {
  it('cuts large results at whole items and keeps them valid JSON', async () => {
    const { fitJson } = await import('../src/main/assistant/tools')
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, description: 'BETALING MET DEBETKAART '.repeat(20), importBatchId: 1, valueDate: '2026-01-01' }))
    const text = fitJson({ items, total: 500, offset: 100 }, 60_000)
    expect(text.length).toBeLessThanOrEqual(60_000)
    const o = JSON.parse(text) as { items: unknown[]; truncated: boolean; nextOffset: number }
    expect(o.truncated).toBe(true)
    expect(o.nextOffset).toBe(100 + o.items.length)
    expect(JSON.stringify(o.items[0])).not.toContain('importBatchId')
  })

  it('never puts a user message straight after tool results', async () => {
    const { toOpenAi } = await import('../src/main/assistant/openai')
    const out = toOpenAi('sys', [
      { role: 'user', content: 'categorise' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'user', content: 'next question' }
    ] as never)
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.role === 'tool' && out[i]!.role === 'user').toBe(false)
  })

  it('lists only models that chat with tools, once per model', async () => {
    const { chatModels } = await import('../src/main/assistant/openai')
    expect(
      chatModels({
        data: [
          { id: 'mistral-large-2411', aliases: ['mistral-large-latest'], capabilities: { completion_chat: true, function_calling: true } },
          { id: 'mistral-large-latest', aliases: ['mistral-large-2411'], capabilities: { completion_chat: true, function_calling: true } },
          { id: 'mistral-embed', capabilities: { completion_chat: false, function_calling: false } },
          { id: 'open-mistral-7b', deprecation: '2025-03-30', capabilities: { completion_chat: true, function_calling: true } },
          { id: 'llama3' }
        ]
      })
    ).toEqual(['llama3', 'mistral-large-latest'])
  })

  it('retries a 503 and then succeeds', async () => {
    const electron = await import('electron')
    const fetch = electron.net.fetch as unknown as ReturnType<typeof vi.fn>
    fetch.mockReset()
    fetch.mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'retry-after': '0' } }))
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
    const { listModels } = await import('../src/main/assistant/openai')
    const { PROVIDERS } = await import('@shared/ai-providers')
    const models = await listModels({ preset: PROVIDERS.mistral, baseUrl: 'https://api.mistral.ai/v1', key: 'k', chatModel: 'm', csvModel: 'm' })
    expect(models).toEqual(['m1'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('checks big files in parts; columns and fixes come only from the first part', async () => {
    const { batches, mergePlans } = await import('../src/main/assistant/csv')
    const groups = Array.from({ length: 170 }, (_, i) => ({ key: String(i) }) as never)
    const b = batches(groups, 80)
    expect(b.map((x) => [x.from, x.groups.length, x.first])).toEqual([[0, 80, true], [80, 80, false], [160, 10, false]])
    const plan = (n: number) => ({ mapping: null, fixes: [{ index: n, action: 'skip', bookingDate: null, amountCents: null, description: null, reason: 'x' }], groups: [{ group: n, categoryId: 1, name: null, description: null }], rules: [], notes: ['ok'] }) as never
    const merged = mergePlans([{ batch: { first: false }, plan: plan(80) }, { batch: { first: true }, plan: plan(0) }])
    expect(merged.fixes.map((f) => f.index)).toEqual([0])
    expect(merged.groups.map((g) => g.group)).toEqual([80, 0])
    expect(merged.notes).toEqual(['ok'])
  })

  it('masks account numbers before a check is sent', async () => {
    const { maskIban } = await import('../src/main/assistant/csv')
    expect(maskIban('Naar BE68 5390 0754 7034 voor huur')).toBe('Naar BE…7034 voor huur')
  })
})

describe('review 14, medium items', () => {
  it('#6 a refused bank balance leaves no half-made account', async () => {
    const { coreOps } = await import('@core/ops')
    const { d } = db()
    const create = coreOps['accounts.create'].handler as (c: unknown, i: unknown) => unknown
    expect(() => create({ db: d }, { name: 'New', bank: '', currency: 'EUR', kind: 'current', openingBalanceCents: 0, iban: 'BE68539007547034', bankBalance: { date: '2999-01-01', cents: 100 } })).toThrow(/today or an earlier day/)
    expect((d.prepare("SELECT count(*) AS n FROM accounts WHERE name = 'New'").get() as { n: number }).n).toBe(0)
  })

  it('#7 today is the local date', async () => {
    const { localToday } = await import('@shared/month')
    expect(localToday(new Date(2026, 10, 15, 0, 30))).toBe('2026-11-15')
  })

  it('#10 #11 a turn that stops keeps changes that ran, and never leaves two questions in a row', async () => {
    const { settleTurn } = await import('../src/main/assistant/chat')
    const q = { role: 'user', content: 'categorise' }
    const call = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'rules_create', input: {} }] }
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
    const call2 = { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'budgets_set', input: {} }] }
    const h1 = [q, call, result, call2] as never[]
    settleTurn(h1, 0, '(Stopped: error)')
    expect((h1 as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(JSON.stringify(h1.at(-1))).toContain('Stopped')
    // Nothing ran: the question is taken back.
    const h2 = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }, q] as never[]
    settleTurn(h2, 2, '(Stopped)')
    expect(h2).toHaveLength(2)
  })

  it('#12 a stream that goes silent ends with a clear message', async () => {
    const electron = await import('electron')
    const fetch = electron.net.fetch as unknown as ReturnType<typeof vi.fn>
    fetch.mockReset()
    fetch.mockImplementation(async (_u: string, init: { signal: AbortSignal }) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n'))
          init.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
        }
      })
      return new Response(body, { status: 200 })
    })
    const { request } = await import('../src/main/assistant/openai')
    const { PROVIDERS } = await import('@shared/ai-providers')
    const open = await request({ preset: PROVIDERS.mistral, baseUrl: 'https://api.mistral.ai/v1', key: 'k', chatModel: 'm', csvModel: 'm' }, '/x', {}, undefined, { timeoutMs: 1000, idleMs: 50 })
    const reader = open.res.body!.getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow()
    expect(open.timedOut()).toMatch(/no answer for/)
  })

  it('#13 a long Retry-After fails at once; #14 a too-high limit is lowered before the schema is dropped', async () => {
    const electron = await import('electron')
    const fetch = electron.net.fetch as unknown as ReturnType<typeof vi.fn>
    const { json, listModels } = await import('../src/main/assistant/openai')
    const { PROVIDERS } = await import('@shared/ai-providers')
    const p = { preset: PROVIDERS.mistral, baseUrl: 'https://api.mistral.ai/v1', key: 'k', chatModel: 'm', csvModel: 'm' }
    fetch.mockReset()
    fetch.mockResolvedValueOnce(new Response('{"message":"rate limited"}', { status: 429, headers: { 'retry-after': '120' } }))
    await expect(listModels(p)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockReset()
    const bodies: { response_format: { type: string }; max_tokens: number }[] = []
    fetch.mockImplementation(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body)
      bodies.push(b)
      if (b.max_tokens > 8192) return new Response('{"message":"max_tokens is too large"}', { status: 400 })
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 })
    })
    expect(await json(p, { system: 's', user: 'u', schema: {}, maxTokens: 32000 })).toBe('{"ok":true}')
    expect(bodies.map((b) => [b.response_format.type, b.max_tokens])).toEqual([['json_schema', 32000], ['json_schema', 8192]])
  })
})
