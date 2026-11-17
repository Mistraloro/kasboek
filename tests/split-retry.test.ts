import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { openDatabase, type Db } from '@core/database'
import { analyze, analyzeGrid, remap } from '@core/import'
import type { PdfLine } from '@core/pdf/lines'
import { setSecret } from '@core/secrets'
import { updateSettings } from '@core/settings'
import { lowerClaudeEffort, lowerReasoning } from '@shared/reasoning'

const sent: { type: string; groupsDone?: number; groupsTotal?: number }[] = []
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_c: string, e: (typeof sent)[number]) => sent.push(e) } }] },
  powerMonitor: { on: vi.fn() }
}))

// All data here is invented.
const OWN = 'BE68539007547034'
type Body = { messages: { role: string; content: string }[]; reasoning_effort?: string }
const requests: Body[] = []
const userText = (b: Body): string => b.messages.find((m) => m.role === 'user')!.content
const reply = (content: string, finish = 'stop'): Response => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })

async function mockFetch(handler: (body: Body, n: number) => Response | Promise<Response>): Promise<void> {
  const { net } = await import('electron')
  const fetch = net.fetch as unknown as ReturnType<typeof vi.fn>
  fetch.mockReset()
  requests.length = 0
  fetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body
    requests.push(body)
    return handler(body, requests.length)
  })
}

function newDb(): { db: Db; accountId: number } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-split-')), 'k.db'), randomBytes(32).toString('hex'))
  const accountId = Number(db.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
  setSecret(db, 'aiKey.mistral', 'test-key')
  updateSettings(db, { aiProvider: 'mistral', aiChatModel: 'm', aiCsvReasoning: 'high' })
  return { db, accountId }
}

beforeEach(() => {
  sent.length = 0
  requests.length = 0
})

describe('lowering the reasoning', () => {
  it('goes one step down and stops at the lowest level the model has', () => {
    expect(lowerClaudeEffort('claude-sonnet-5-5', 'high')).toBe('medium')
    expect(lowerClaudeEffort('claude-sonnet-5-5', 'low')).toBe('off')
    expect(lowerClaudeEffort('claude-sonnet-5-5', 'off')).toBe('off')
    expect(lowerClaudeEffort('claude-opus-5-5', 'low')).toBe('low')
    expect([lowerReasoning('high'), lowerReasoning('default'), lowerReasoning('low'), lowerReasoning('off')]).toEqual(['medium', 'low', 'off', 'off'])
  })
})

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A job over the numbers lo..hi that can be split down to one number. */
async function ranges(db: Db, opts: { signal?: AbortSignal; min?: number; done?: (p: [number, number]) => void } = {}) {
  const { callJsonSplit } = await import('../src/main/assistant/json')
  const { activeProvider } = await import('../src/main/assistant/provider')
  const { AppError } = await import('@core/errors')
  const Schema = z.object({ ok: z.array(z.number()) })
  type P = [number, number]
  const min = opts.min ?? 1
  return (part: P) =>
    callJsonSplit<P, number[]>(
      db,
      activeProvider(db),
      { system: 's', schema: Schema, signal: opts.signal ?? new AbortController().signal },
      {
        part,
        context: (p) => JSON.stringify(p),
        parse: (text) => {
          const r = Schema.safeParse(safeJson(text))
          if (!r.success) throw new AppError('assistant.bad_plan', 'unreadable')
          return r.data.ok
        },
        split: (p) => (p[1] - p[0] <= min ? null : [[p[0], p[0] + Math.ceil((p[1] - p[0]) / 2)], [p[0] + Math.ceil((p[1] - p[0]) / 2), p[1]]]),
        describe: (p) => `rows ${p[0] + 1} to ${p[1]}`,
        done: opts.done,
        timedOut: () => new AppError('assistant.timeout', 'slow')
      }
    )
}
const rangeOf = (b: Body): [number, number] => JSON.parse(userText(b)) as [number, number]
const answerRange = ([lo, hi]: [number, number]): Response => reply(JSON.stringify({ ok: Array.from({ length: hi - lo }, (_, i) => lo + i) }))

describe('a part whose answer is cut off', () => {
  it('is split in halves that are both asked and merged (finish_reason length)', async () => {
    const { db } = newDb()
    await mockFetch((b) => {
      const [lo, hi] = rangeOf(b)
      return hi - lo > 5 ? reply('{"ok":[0,1', 'length') : answerRange([lo, hi])
    })
    const out = await (await ranges(db))([0, 8])
    expect(out.failed).toEqual([])
    expect(out.answered.map((a) => a.part)).toEqual([[0, 4], [4, 8]])
    expect(out.answered.flatMap((a) => a.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(requests.map(rangeOf)).toEqual([[0, 8], [0, 4], [4, 8]])
  })

  it('is split when the JSON is cut off without a stop reason, but not when it is merely wrong', async () => {
    const { db } = newDb()
    await mockFetch((b) => {
      const [lo, hi] = rangeOf(b)
      return hi - lo > 2 ? reply('{"ok":[0,1,') : answerRange([lo, hi])
    })
    const out = await (await ranges(db))([0, 4])
    expect(out.answered.map((a) => a.part)).toEqual([[0, 2], [2, 4]])
    // Valid JSON of the wrong shape is not a length problem: no retry.
    await mockFetch(() => reply('{"nope":true}'))
    const bad = await (await ranges(db))([0, 4])
    expect(requests).toHaveLength(1)
    expect(bad.failed).toHaveLength(1)
    expect(bad.answered).toEqual([])
  })

  it('lowers the reasoning for the retry', async () => {
    const { db } = newDb()
    await mockFetch((b) => (rangeOf(b)[1] - rangeOf(b)[0] > 2 ? reply('{"ok":[', 'length') : answerRange(rangeOf(b))))
    await (await ranges(db))([0, 4])
    // high for the first answer, medium for the halves.
    expect(requests.map((b) => b.reasoning_effort)).toEqual(['high', 'medium', 'medium'])
  })

  it('tries the same part again with less reasoning when only reasoning came out', async () => {
    const { db } = newDb()
    await mockFetch((b, n) => (n === 1 ? reply('', 'length') : answerRange(rangeOf(b))))
    const out = await (await ranges(db))([0, 4])
    expect(requests.map(rangeOf)).toEqual([[0, 4], [0, 4]])
    expect(requests.map((b) => b.reasoning_effort)).toEqual(['high', 'medium'])
    expect(out.answered).toHaveLength(1)
  })

  it('splits at once when the reasoning can not be lowered any more', async () => {
    const { db } = newDb()
    updateSettings(db, { aiCsvReasoning: 'off' })
    await mockFetch((b, n) => (n === 1 ? reply('', 'length') : answerRange(rangeOf(b))))
    const out = await (await ranges(db))([0, 4])
    expect(requests.map(rangeOf)).toEqual([[0, 4], [0, 2], [2, 4]])
    expect(out.answered).toHaveLength(2)
  })

  it('keeps the answers of the other half and says where the failed one is', async () => {
    const { db } = newDb()
    await mockFetch((b) => {
      const [lo, hi] = rangeOf(b)
      return hi - lo > 4 || lo >= 4 ? reply('{"ok":[', 'length') : answerRange([lo, hi])
    })
    const out = await (await ranges(db, { min: 4 }))([0, 8])
    expect(out.answered.map((a) => a.part)).toEqual([[0, 4]])
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]!.part).toEqual([4, 8])
    expect(out.failed[0]!.error).toMatchObject({ code: 'assistant.too_long' })
    expect((out.failed[0]!.error as Error).message).toMatch(/rows 5 to 8.*bigger output limit.*split the file/)
  })

  it('stops splitting at the smallest part and never loops', async () => {
    const { db } = newDb()
    await mockFetch(() => reply('{"ok":[', 'length'))
    const small = await (await ranges(db, { min: 5 }))([0, 5])
    expect(requests).toHaveLength(1)
    expect(small.failed).toHaveLength(1)
    // A big part that always fails is bounded in calls, not split down forever.
    await mockFetch(() => reply('{"ok":[', 'length'))
    const big = await (await ranges(db))([0, 5000])
    expect(requests.length).toBeLessThanOrEqual(16)
    expect(big.answered).toEqual([])
    expect(big.failed.length).toBeGreaterThan(0)
  })

  it('ends at once when stopped during the retries', async () => {
    const { db } = newDb()
    const stop = new AbortController()
    await mockFetch((_b, n) => {
      if (n === 2) stop.abort('cancelled')
      return reply('{"ok":[', 'length')
    })
    await expect((await ranges(db, { signal: stop.signal }))([0, 8])).rejects.toBeDefined()
    expect(requests).toHaveLength(2)
  })

  it('reports each answered part once', async () => {
    const { db } = newDb()
    await mockFetch((b) => (rangeOf(b)[1] - rangeOf(b)[0] > 4 ? reply('{"ok":[', 'length') : answerRange(rangeOf(b))))
    const done: [number, number][] = []
    await (await ranges(db, { done: (p) => done.push(p) }))([0, 8])
    expect(done).toEqual([[0, 4], [4, 8]])
  })
})

// ------------------------------------------------------------------------------------------- PDF

const line = (id: number, page: number, cells: [number, string][]): PdfLine => ({ id, page, y: 800 - id * 12, pageHeight: 842, cells: cells.map(([x, text]) => ({ text, x0: x, x1: x + text.length * 5 })) })

/** A statement of `pages` pages with a payment on each of `perPage` rows (one line each). */
function statement(pages: number, perPage = 3): PdfLine[] {
  const lines: PdfLine[] = [line(0, 1, [[60, 'Date'], [140, 'Description'], [400, 'Amount'], [510, 'Balance']])]
  for (let p = 1; p <= pages; p++)
    for (let r = 1; r <= perPage; r++) lines.push(line(lines.length, p, [[60, `${String(r).padStart(2, '0')}/11`], [140, `SHOP ${p} ${r}`], [400, `${r},50-`], [510, '100,00']]))
  return lines
}

function pdfSession(lines: PdfLine[]): { db: Db; sessionId: string } {
  const { db, accountId } = newDb()
  const pages = new Set(lines.map((l) => l.page)).size
  const preview = analyzeGrid(db, { fileName: 's.pdf', accountId, grid: [], pdf: { lines, pages, readBy: 'kasboek', balances: { opening: null, closing: null }, period: { from: '2026-11-01', to: '2026-11-30' }, notes: [{ code: 'no_table', pages, lines: lines.length }] } })
  return { db, sessionId: preview.sessionId }
}

/** Answers with one row per own line of the part. */
function rowsFor(b: Body): Response {
  const rows = userText(b)
    .split('\n')
    .flatMap((l) => {
      const m = /^L(\d+) p\d+ \| x60 (\d\d\/\d\d) \| x140 (.+?) \| x400 (\S+) \| x510 (\S+)$/.exec(l)
      return m ? [{ lines: [Number(m[1])], date: m[2], valueDate: null, amount: m[4], direction: null, balance: m[5], counterparty: m[3] }] : []
    })
  return reply(JSON.stringify({ rows, openingBalance: null, closingBalance: null, notes: [] }))
}
const ownLines = (b: Body): number => userText(b).split('\n').filter((l) => /^L\d+ p/.test(l)).length

describe('reading a PDF statement in smaller pieces', () => {
  it('splits a part that was cut off and still reads every transaction once, with progress that only goes up', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = pdfSession(statement(4, 6))
    await mockFetch((b) => (ownLines(b) > 12 ? reply('{"rows":[{"lines":[1', 'length') : rowsFor(b)))
    const preview = await assistPdf(db, sessionId)
    expect(preview.rows).toHaveLength(24)
    expect(preview.stats.problems).toBe(0)
    expect(preview.notes.join(' ')).not.toMatch(/couldn’t be read/)
    expect(requests.length).toBeGreaterThan(1)
    const done = sent.filter((e) => e.type === 'import.checkProgress').map((e) => e.groupsDone!)
    expect(done).toEqual([...done].sort((a, b) => a - b))
    expect(done.at(-1)).toBe(4)
  })

  it('names the lines that could not be read, and keeps the other parts', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = pdfSession(statement(8, 3))
    // Part 2 (pages 5 to 8) always comes back cut off.
    await mockFetch((b) => (/L1[3-9] p[5-8]|L2\d p[5-8]/.test(userText(b)) ? reply('{"rows":[', 'length') : rowsFor(b)))
    const preview = await assistPdf(db, sessionId)
    expect(preview.rows).toHaveLength(12)
    expect(preview.notes.join(' ')).toMatch(/1 of 2 parts couldn’t be read \(part 2\).*lines 13 to 18 \(page 5 to 6\), lines 19 to 24.*bigger output limit/)
  })

  it('is an error that says where when nothing could be read', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { db, sessionId } = pdfSession(statement(1, 3))
    await mockFetch(() => reply('{"rows":[', 'length'))
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject({ code: 'assistant.too_long', message: expect.stringMatching(/lines \d+ to 3/) })
    expect(requests).toHaveLength(1)
  })

  it('stops when the person presses Stop between retries', async () => {
    const { assistPdf } = await import('../src/main/assistant/pdf')
    const { cancelAssist } = await import('../src/main/assistant/jobs')
    const { db, sessionId } = pdfSession(statement(4, 6))
    await mockFetch((_b, n) => {
      if (n === 2) cancelAssist(sessionId)
      return reply('{"rows":[', 'length')
    })
    await expect(assistPdf(db, sessionId)).rejects.toMatchObject({ code: 'assistant.cancelled' })
    expect(requests).toHaveLength(2)
  })
})

describe('part sizes', () => {
  it('cuts a long page range by lines, and a part in halves at the start of a transaction', async () => {
    const { maskedLines, splitParts, splitPart, MAX_PART_LINES } = await import('@core/pdf-plan')
    const lines = statement(1, 400)
    const parts = splitParts(maskedLines(lines))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.own.length <= MAX_PART_LINES)).toBe(true)
    const [a, b] = splitPart(parts[0]!)!
    expect([...a.own, ...b.own]).toEqual(parts[0]!.own)
    expect(b.context.map((m) => m.id)).toEqual(a.own.slice(-3).map((m) => m.id))
    expect(a.context).toEqual(parts[0]!.context)
    expect(splitPart({ ...a, own: a.own.slice(0, 10) })).toBeNull()
  })
})

// -------------------------------------------------------------------------------------------- CSV

const MAPPING = { delimiter: ';', headerRow: 0, dateOrder: 'YMD', decimal: ',', invertSign: false, columns: { bookingDate: 0, counterpartyName: 1, description: [2], amount: 3 } } as const

describe('checking a CSV in smaller pieces', () => {
  it('sizes parts by the expected answer, flagged rows included, and splits keeping the column check first', async () => {
    const { batches, splitBatch, mergePlans } = await import('../src/main/assistant/csv')
    const groups = Array.from({ length: 100 }, (_, i) => ({ key: String(i) }) as never)
    const flagged = Array.from({ length: 150 }, (_, i) => i * 2)
    const b = batches(groups, 80, flagged)
    // 150 flagged rows do not fit in one answer: they come in several parts, each with some groups.
    expect(b.length).toBeGreaterThan(2)
    expect(b.flatMap((x) => x.flagged)).toEqual(flagged)
    expect(b.flatMap((x) => x.groups)).toHaveLength(100)
    expect(b.map((x) => x.first)).toEqual(b.map((_, i) => i === 0))
    expect(b.map((x) => x.from)).toEqual(b.map((_, i) => b.slice(0, i).reduce((n, y) => n + y.groups.length, 0)))
    const halves = splitBatch(b[1]!)!
    expect(halves[0].first).toBe(false)
    expect([...halves[0].groups, ...halves[1].groups]).toEqual(b[1]!.groups)
    expect(halves[1].from).toBe(b[1]!.from + halves[0].groups.length)
    expect(splitBatch({ ...b[1]!, groups: b[1]!.groups.slice(0, 3), flagged: b[1]!.flagged.slice(0, 2) })).toBeNull()
    expect(splitBatch(batches(groups.slice(0, 6), 80)[0]!)).not.toBeNull()
    expect(splitBatch(batches(groups.slice(0, 5), 80)[0]!)).toBeNull()
    // Fixes of a part that holds flagged rows count, for those rows only.
    const fix = (index: number) => ({ index, action: 'skip', bookingDate: null, amountCents: null, description: null, reason: 'x' })
    const plan = (fixes: unknown[]) => ({ mapping: null, fixes, groups: [], rules: [], notes: [] }) as never
    const merged = mergePlans([
      { batch: { first: false, from: 5, groups: [], flagged: [7, 9] }, plan: plan([fix(7), fix(8)]) },
      { batch: { first: true, from: 0, groups: [], flagged: [1] }, plan: plan([fix(1), fix(7)]) }
    ])
    expect(merged.fixes.map((f) => f.index)).toEqual([1, 7])
  })

  it('splits a check that was cut off, applies both halves and counts progress once', async () => {
    const { assistImport } = await import('../src/main/assistant/csv')
    const { db, accountId } = newDb()
    const groceries = (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id
    const lines = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')};Shop ${String.fromCharCode(65 + i)} Town;card;-${i + 1},00`)
    const p = analyze(db, { fileName: 'x.csv', bytes: new TextEncoder().encode(['Date;Payee;Memo;Amount', ...lines].join('\n')), accountId })
    remap(db, p.sessionId, MAPPING)
    await mockFetch((b) => {
      const groupLines = (JSON.parse(userText(b)) as { groups: { groups: string[] } }).groups.groups
      if (groupLines.length > 6) return reply('{"mapping":null,"fixes":[', 'length')
      const answers = groupLines.map((l) => ({ group: Number(l.split(' | ')[0]), categoryId: groceries, name: null, description: null }))
      return reply(JSON.stringify({ mapping: null, fixes: [], groups: answers, rules: [], notes: ['Checked.'] }))
    })
    const preview = await assistImport(db, p.sessionId)
    expect(requests).toHaveLength(3)
    expect(preview.rows.every((r) => r.categoryId === groceries)).toBe(true)
    expect(preview.notes.join(' ')).not.toMatch(/couldn’t be checked/)
    // The first half still checks the columns; the second only its groups.
    expect(userText(requests[1]!)).toContain('check the columns')
    expect(userText(requests[2]!)).toContain('Return mapping null')
    const done = sent.filter((e) => e.type === 'import.checkProgress').map((e) => e.groupsDone!)
    expect(done).toEqual([0, 6, 12])
  })
})
