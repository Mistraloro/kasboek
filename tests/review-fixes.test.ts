import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@core/database'
import { analyze, applyCheckProposals, commit, getCheck, remap, setCheck, snapshot, undoCheck, updateRows } from '@core/import'
import { createRule, insertTransaction, listRules, matchRule, previewRule, reorderRules, textMatches, updateRule } from '@core/finance'
import { parsePlan, rowGroups } from '@core/assist-plan'

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
        dropped: []
      },
      before,
      parts: { categories: [0], names: [0], fixes: [1] },
      existingIds: new Map([[1, [old]]])
    })
    let q = undoCheck(d, p.sessionId, 'names')
    expect(q.rows[0]).toMatchObject({ counterpartyName: 'COLRUYT BRUGGE', categoryId: groceries })
    expect(q.check?.renamed).toBe(0)
    const applied = applyCheckProposals(d, p.sessionId, { rules: [1], existing: [1] })
    expect(applied.rules).toBe(1)
    expect((d.prepare('SELECT category_id FROM transactions WHERE id = ?').get(old) as { category_id: number }).category_id).toBe(groceries)
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

  it('masks account numbers before a check is sent', async () => {
    const { maskIban } = await import('../src/main/assistant/csv')
    expect(maskIban('Naar BE68 5390 0754 7034 voor huur')).toBe('Naar BE…7034 voor huur')
  })
})
