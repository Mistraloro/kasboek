/**
 * "Check with Claude" on the import screen. Claude returns a plan (column mapping, row fixes,
 * readable names, descriptions and categories per group of similar rows, notes) in a strict JSON format. Code then applies it through the same checks as a
 * manual change, so Claude never writes amounts straight into the database.
 */
import { z } from 'zod'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { listRules, ruleMatches } from '@core/finance'
import * as imp from '@core/import'
import { getSettings } from '@core/settings'
import { mappingSchema } from '@shared/import-mapping'
import type { ImportPreview, ProposedCategorisation, ProposedRule } from '@shared/types'
import { MAX_GROUPS, Plan, groupKey, parsePlan, rowGroups, type ExistingTx, type RowGroup } from '@core/assist-plan'
import { client, explainError, modelParams } from './claude'
import * as openai from './openai'
import { activeProvider, requireConfigured } from './provider'
import { app } from 'electron'
import { broadcast } from '../session'



const INSTRUCTIONS = `You check a bank CSV export before it is imported into a personal budget app (Belgium; banks such as Argenta, Hello bank!, Keytrade Bank; Dutch/French/English headers; dates usually DD/MM/YYYY; decimal comma).

You get the raw cells, the column mapping the app detected, the rows it couldn't read or flagged, groups of similar transactions and the categories. Rows that are exactly the same as transactions already in Kasboek are left out (the stats say how many). Return a plan:
- mapping: only if the current mapping is wrong or missing, else null. Column numbers are zero-based indexes into the header row. headerRow is the index of the header line among all lines. Prefer a single signed amount column; use debit/credit only when the file has them. invertSign only if money out is positive in this file.
- fixes: only for rows whose correct value is clear from the raw cells. action "fix" with a corrected bookingDate (YYYY-MM-DD), amountCents (integer, negative = money out) or description; "skip" for lines that are not transactions (totals, opening/closing balance, repeated headers, refused payments); "include" for a flagged row that is clearly a separate real transaction. Rows with status possible_duplicate come with the transaction already in Kasboek they resemble (same amount, a few days apart, similar text): answer "skip" if it is the same payment (the bank reworded the text or moved the date) or "include" if it is a different one. Set fields you don't change to null. reason: a few words.
- groups: the transactions come in groups of similar ones (same counterparty or description, same direction). A group can hold new rows of this file and transactions already in Kasboek that have no category yet. Give one entry per group; the app applies it to every row in the group. Banks write these texts differently, so read them carefully:
  - categoryId: for groups marked "uncategorised", a category id from the list. Most have an obvious category (supermarkets, bakeries, energy, telecom, rent, salary, restaurants, fuel, insurance, …): categorise every group where one fits; null only if you really can't tell. Transfers between the person's own accounts (savings, own accounts) go in a transfer category, not spending. Use only the category ids given. null for groups that already have a category.
  - name: who the money went to or came from, short and readable, as people would say it: the shop, company or person (e.g. "Delhaize", "Bakkerij De Roos", "Engie", "Jan Peeters"), found in the counterparty or inside the bank text (card payments often put the shop and its address after the card number). Use normal capitalisation, not all caps. null if the text gives no name.
  - description: a short, readable description without card numbers, account numbers, references, value dates or times, in the language of the bank text (e.g. "Kaartbetaling Bancontact, Brugge", "Automatisch sparen", "Overschrijving via Wero"). Keep anything the person would want to read, such as the communication of a transfer. null to keep the bank's text.
- rules: rules make future imports categorise themselves. Suggest one only for a payee that comes back (a group with 2 or more transactions, or a known shop, employer, utility or subscription). field: where the text is ("counterparty" if the counterparty column holds the name, else "description"). pattern: a distinctive piece of the bank's own text (as written in the counterparty or bank text column, not your readable name), at least 4 characters, that is in every transaction of the group and wouldn't appear in unrelated payments: the shop or company name, not a city, card number, date or generic word like "BETALING". match: "word" for a name that must stand alone, else "contains". categoryId: the category for the group. Don't suggest rules that already exist.
- notes: 1 to 5 short sentences for the person: what you checked, what you changed, anything they should look at. Plain English.
Never invent amounts or dates that are not supported by the raw cells.`

/** Account numbers don't help the check: only the country and last four digits are sent. */
const IBAN = /\b([A-Z]{2})\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g
export const maskIban = (text: string): string => text.replace(IBAN, (m, cc: string) => `${cc}…${m.replace(/\s/g, '').slice(-4)}`)

/** At most `n` items spread over the whole list rather than only the first ones. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!)
}

/** Uncategorised transactions of this account already in Kasboek, so Check can sort them too. */
function existingUncategorised(db: Db, accountId: number): ExistingTx[] {
  return (
    db
      .prepare(
        `SELECT id, booking_date, amount_cents, counterparty_name, description FROM transactions
         WHERE account_id = ? AND category_id IS NULL ORDER BY booking_date DESC LIMIT 5000`
      )
      .all(accountId) as { id: number; booking_date: string; amount_cents: number; counterparty_name: string | null; description: string }[]
  ).map((r) => ({ id: r.id, bookingDate: r.booking_date, amountCents: r.amount_cents, counterpartyName: r.counterparty_name, description: r.description }))
}

interface Batch {
  /** Index of the first group of this batch among all groups. */
  from: number
  groups: RowGroup[]
  /** The first batch also checks the columns, flagged rows and possible duplicates. */
  first: boolean
  n: number
  of: number
}

function buildContext(db: Db, preview: ImportPreview, batch: Batch): string {
  const groups = batch.groups
  const raw = imp.rawWindow(preview.sessionId, 0, 25)
  const cells = (index: number): string[] | undefined => imp.rawWindow(preview.sessionId, index, 1).rows[0]?.cells.map(maskIban)
  // Exact duplicates are already in Kasboek: not sent again.
  const flagged = spread(preview.rows.filter((r) => r.status !== 'ready' && r.status !== 'duplicate'), 150).map((r) => ({
    index: r.index,
    status: r.status,
    issues: r.issues,
    cells: cells(r.index),
    ...(r.match ? { inKasboek: { date: r.match.bookingDate, counterparty: r.match.counterpartyName, description: maskIban(r.match.description.slice(0, 300)) } } : {})
  }))
  const catName = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]))
  const lines = groups.map((g, i) => {
    const cat = g.example.categoryId === null ? 'uncategorised' : (catName.get(g.example.categoryId) ?? 'categorised')
    const comm = g.example.communication ? ` | communication: ${maskIban(g.example.communication.slice(0, 120))}` : ''
    return `${batch.from + i} | ${g.rows.length} | ${g.existing.length} | ${g.sign} | ${g.example.amountCents} | ${g.totalCents} | ${cat} | ${maskIban(g.example.counterpartyName ?? '')} | ${maskIban(g.example.description.slice(0, 400))}${comm}`
  })
  const categories = (db.prepare('SELECT id, name, kind FROM categories WHERE archived = 0 ORDER BY kind, name').all() as { id: number; name: string; kind: string }[]).map((c) => `${c.id}: ${c.name} (${c.kind})`)
  const account = db.prepare('SELECT name, currency, bank, kind FROM accounts WHERE id = ?').get(preview.accountId)
  return JSON.stringify(
    {
      ...(batch.of > 1
        ? {
            batch: batch.first
              ? `Part ${batch.n} of ${batch.of}: check the columns and flagged rows, and the groups below. The other groups are checked separately.`
              : `Part ${batch.n} of ${batch.of}: only the groups below. Return mapping null and no fixes; the columns and flagged rows are checked in part 1.`
          }
        : {}),
      account,
      fileName: preview.fileName,
      recognisedLayout: preview.layout,
      delimiter: preview.mapping?.delimiter,
      currentMapping: preview.mapping,
      stats: preview.stats,
      linesAboveHeader: raw.preamble.map((r) => r.map(maskIban)),
      header: raw.header.map((h, i) => `${i}: ${h}`),
      firstRows: batch.first ? raw.rows.map((r) => ({ index: r.index, cells: r.cells.map(maskIban) })) : raw.rows.slice(0, 5).map((r) => ({ index: r.index, cells: r.cells.map(maskIban) })),
      flaggedRows: batch.first ? flagged : [],
      groups: { format: 'group | new rows | already in Kasboek | in/out | example amountCents | total amountCents | category now | counterparty | bank text', groups: lines },
      categories,
      rules: listRules(db).map((r) => `${r.field} ${r.match} "${r.pattern}" → ${r.categoryId}`)
    },
    null,
    1
  )
}

type Change = Parameters<typeof imp.updateRows>[2][number]

function applyPlan(db: Db, preview: ImportPreview, groups: RowGroup[], plan: Plan, name: string): ImportPreview {
  const notes = [...plan.notes.slice(0, 6)]
  const dropped: string[] = []
  const before = imp.snapshot(preview.sessionId)
  let current = preview
  let mappingChanged = false
  if (plan.mapping && preview.mapping) {
    const strip = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T
    const candidate = { ...plan.mapping, delimiter: preview.mapping.delimiter, columns: strip(plan.mapping.columns) }
    const parsed = mappingSchema.safeParse(candidate)
    try {
      if (!parsed.success) throw new Error('invalid')
      const next = imp.remap(db, preview.sessionId, parsed.data, 'assistant')
      // Keep the new mapping only if it doesn't make things worse.
      if (next.stats.ready + next.stats.duplicates < preview.stats.ready + preview.stats.duplicates) {
        current = imp.remap(db, preview.sessionId, preview.mapping, preview.mappingSource)
        notes.push(`${name} suggested different columns, but they read fewer rows, so the detected columns were kept.`)
      } else {
        current = next
        mappingChanged = JSON.stringify(parsed.data) !== JSON.stringify(preview.mapping)
      }
    } catch {
      notes.push(`${name}’s column suggestion didn’t fit this file, so the detected columns were kept.`)
    }
  } else if (plan.mapping && !preview.mapping) {
    const parsed = mappingSchema.safeParse({ ...plan.mapping, delimiter: ';', columns: Object.fromEntries(Object.entries(plan.mapping.columns).filter(([, v]) => v !== null)) })
    if (parsed.success) {
      try {
        current = imp.remap(db, preview.sessionId, parsed.data, 'assistant')
        mappingChanged = true
      } catch {
        notes.push(`${name}’s column suggestion didn’t fit this file.`)
      }
    }
  }

  const byIndex = new Map(current.rows.map((r) => [r.index, r]))
  const validCats = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]))
  const changes: Change[] = []
  const parts = { categories: [] as number[], names: [] as number[], fixes: [] as number[] }
  for (const f of plan.fixes) {
    const row = byIndex.get(f.index)
    if (!row) continue
    const note = f.reason.slice(0, 200)
    if (f.action === 'skip') changes.push({ index: f.index, decided: 'skip', note })
    else if (f.action === 'include') {
      if (row.status === 'problem') continue
      changes.push({ index: f.index, decided: 'include', note })
    } else {
      const c: Change = { index: f.index, note }
      if (f.bookingDate && /^\d{4}-\d{2}-\d{2}$/.test(f.bookingDate) && !Number.isNaN(Date.parse(f.bookingDate))) c.bookingDate = f.bookingDate
      if (f.amountCents !== null && Number.isSafeInteger(f.amountCents) && f.amountCents !== 0) c.amountCents = f.amountCents
      if (f.description?.trim()) c.description = f.description.trim().slice(0, 300)
      if (Object.keys(c).length <= 2) continue
      changes.push(c)
    }
    parts.fixes.push(f.index)
  }

  // Groups as the model saw them; after a column change rows are matched by their text again.
  const byKey = new Map<string, Plan['groups'][number]>()
  for (const g of plan.groups) {
    const group = groups[g.group]
    if (group) byKey.set(group.key, g)
  }
  const fixed = new Set(parts.fixes)
  for (const r of current.rows) {
    if (r.status !== 'ready' || fixed.has(r.index)) continue
    const g = byKey.get(groupKey(r))
    if (!g) continue
    const c: Change = { index: r.index }
    if (r.categoryId === null && g.categoryId !== null && validCats.has(g.categoryId)) {
      c.categoryId = g.categoryId
      c.categorySource = 'assistant'
      parts.categories.push(r.index)
    }
    const newName = g.name?.trim().slice(0, 120)
    const newDescription = g.description?.trim().slice(0, 300)
    if (newName && newName !== r.counterpartyName) c.counterpartyName = newName
    if (newDescription && newDescription !== r.description) c.description = newDescription
    if (c.counterpartyName || c.description) parts.names.push(r.index)
    if (Object.keys(c).length > 1) changes.push(c)
  }
  if (changes.length) current = imp.updateRows(db, preview.sessionId, changes)

  // Transactions already in Kasboek: proposals only, applied when the person accepts them.
  const existing: ProposedCategorisation[] = []
  const existingIds = new Map<number, number[]>()
  for (const g of plan.groups) {
    const group = groups[g.group]
    if (!group?.existing.length || g.categoryId === null || !validCats.has(g.categoryId)) continue
    const id = existing.length + 1
    existing.push({
      id,
      label: g.name?.trim() || group.example.counterpartyName || group.example.description.slice(0, 60),
      categoryId: g.categoryId,
      categoryName: validCats.get(g.categoryId)!,
      count: group.existing.length,
      totalCents: group.existing.reduce((t, e) => t + e.amountCents, 0)
    })
    existingIds.set(id, group.existing.map((e) => e.id))
  }

  const rules = checkRules(db, preview.sessionId, groups, plan, validCats, dropped)
  const duplicates = current.stats.duplicates
  imp.setCheck(preview.sessionId, {
    summary: { by: name, alreadyImported: duplicates, total: current.stats.total, mappingChanged, rules, existing, dropped },
    before,
    parts,
    existingIds
  })
  imp.addNotes(preview.sessionId, notes)
  return imp.preview(db, preview.sessionId)
}

/** Shortest text a suggested rule may use: shorter ones catch unrelated payments. */
const MIN_RULE_PATTERN = 4

/**
 * Keeps the suggested rules that are safe: the text is long enough, is in every transaction of its
 * group (as the bank writes it, so the next import matches too), and doesn't catch transactions
 * that belong in another category.
 */
function checkRules(db: Db, sessionId: string, groups: RowGroup[], plan: Plan, cats: Map<number, string>, dropped: string[]): ProposedRule[] {
  const existingRules = listRules(db)
  const rows = imp.rowsWithBankText(db, sessionId).filter((r) => r.row.status === 'ready')
  // Which group each row was in when the model saw it (names may have changed since).
  const groupOf = new Map<number, string>()
  for (const g of groups) for (const r of g.rows) groupOf.set(r.index, g.key)
  const planned = new Map<string, number | null>()
  for (const g of plan.groups) {
    const group = groups[g.group]
    if (group) planned.set(group.key, g.categoryId ?? group.example.categoryId)
  }
  for (const g of groups) if (!planned.has(g.key)) planned.set(g.key, g.example.categoryId)
  const categorised = db.prepare('SELECT counterparty_name, description, category_id FROM transactions WHERE category_id IS NOT NULL').all() as {
    counterparty_name: string | null
    description: string
    category_id: number
  }[]
  const uncategorised = db.prepare('SELECT counterparty_name, description FROM transactions WHERE category_id IS NULL').all() as { counterparty_name: string | null; description: string }[]
  const out: ProposedRule[] = []
  const seen = new Set<string>()
  for (const r of plan.rules) {
    const group = groups[r.group]
    const pattern = r.pattern.trim().replace(/\s+/g, ' ').slice(0, 100)
    const rule = { field: r.field, pattern, match: r.match }
    const label = `“${pattern}”`
    if (!group || !cats.has(r.categoryId)) continue
    if (pattern.length < MIN_RULE_PATTERN) {
      dropped.push(`Rule ${label} left out: the text is too short to be safe.`)
      continue
    }
    const key = `${r.field}|${pattern.toLowerCase()}`
    if (seen.has(key) || existingRules.some((e) => e.field === r.field && e.pattern.toLowerCase() === pattern.toLowerCase())) continue
    seen.add(key)
    const hit = (t: { counterpartyName: string | null; description: string }): boolean => ruleMatches(rule, t)
    const rowHit = (x: (typeof rows)[number]): boolean => hit(x.raw) || hit(x.row)
    const own = rows.filter((x) => groupOf.get(x.row.index) === group.key)
    if (own.length + group.existing.length === 0 || !own.every(rowHit) || !group.existing.every((e) => hit(e))) {
      dropped.push(`Rule ${label} left out: it doesn’t match every transaction it was meant for.`)
      continue
    }
    // Other payees it would also catch, in this file and among the uncategorised transactions.
    const otherGroups = new Set<string>()
    let clash = 0
    for (const x of rows) {
      const k = groupOf.get(x.row.index)
      if (k === group.key || !rowHit(x)) continue
      if (k) otherGroups.add(k)
      if ((x.row.categoryId ?? (k ? planned.get(k) : null) ?? null) !== r.categoryId) clash++
    }
    for (const g of groups) {
      if (g.key === group.key) continue
      const n = g.existing.filter((e) => hit(e)).length
      if (!n) continue
      otherGroups.add(g.key)
      if (planned.get(g.key) !== r.categoryId) clash += n
    }
    // A text like "BETALING" or "BANKREFERENTIE" is in many unrelated payments.
    if (otherGroups.size > 5) {
      dropped.push(`Rule ${label} left out: the text is too general (it is in ${otherGroups.size} other kinds of payment).`)
      continue
    }
    const clashBefore = categorised.filter((t) => t.category_id !== r.categoryId && hit({ counterpartyName: t.counterparty_name, description: t.description })).length
    const agreeBefore = categorised.filter((t) => t.category_id === r.categoryId && hit({ counterpartyName: t.counterparty_name, description: t.description })).length
    if (clash || clashBefore > Math.max(1, agreeBefore / 5)) {
      dropped.push(`Rule ${label} → ${cats.get(r.categoryId)} left out: it would also catch ${clash + clashBefore} transaction(s) that belong elsewhere.`)
      continue
    }
    out.push({
      id: out.length + 1,
      field: r.field,
      match: r.match,
      pattern,
      categoryId: r.categoryId,
      categoryName: cats.get(r.categoryId)!,
      rowsHere: rows.filter(rowHit).length,
      existing: uncategorised.filter((t) => hit({ counterpartyName: t.counterparty_name, description: t.description })).length
    })
  }
  return out
}

/** Each part of a check that runs too long is stopped, so the import screen never waits forever. */
const TIME_LIMIT_MS = 4 * 60_000
/** Dev builds only: a shorter limit, to test what happens when a part runs out of time. */
const limitMs = (): number => (!app.isPackaged && Number(process.env['KASBOEK_CHECK_LIMIT_MS'])) || TIME_LIMIT_MS
/** Groups per model call, and calls at the same time: a big file is checked in parts. */
const BATCH_GROUPS = 80
const PARALLEL = 3
const running = new Map<string, AbortController>()

/** Stops a running check for this import (the "Stop" button). */
export function cancelAssist(sessionId: string): void {
  running.get(sessionId)?.abort('cancelled')
}

export async function assistImport(db: Db, sessionId: string): Promise<ImportPreview> {
  running.get(sessionId)?.abort('cancelled')
  const controller = new AbortController()
  running.set(sessionId, controller)
  try {
    return await check(db, sessionId, controller.signal)
  } catch (err) {
    if (controller.signal.aborted) throw new AppError('assistant.cancelled', 'Check stopped.')
    throw err
  } finally {
    if (running.get(sessionId) === controller) running.delete(sessionId)
  }
}

/** Splits the groups into parts; the first part also carries the columns and flagged rows. */
export function batches(groups: RowGroup[], size = BATCH_GROUPS): Omit<Batch, 'of'>[] {
  const out: Omit<Batch, 'of'>[] = []
  for (let from = 0; from < Math.max(groups.length, 1); from += size) out.push({ from, groups: groups.slice(from, from + size), first: from === 0, n: out.length + 1 })
  return out
}

/** Puts the parts' answers together: columns and row fixes come only from the first part. */
export function mergePlans(parts: { batch: Pick<Batch, 'first'>; plan: Plan }[]): Plan {
  const first = parts.find((p) => p.batch.first)?.plan
  return {
    mapping: first?.mapping ?? null,
    fixes: first?.fixes ?? [],
    groups: parts.flatMap((p) => p.plan.groups),
    rules: parts.flatMap((p) => p.plan.rules),
    notes: [...new Set(parts.flatMap((p) => p.plan.notes))].slice(0, 6)
  }
}

/** Runs `work` over the items with at most `limit` at a time; failures are returned, not thrown. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  const results: ({ ok: true; value: R } | { ok: false; error: unknown })[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { ok: true, value: await work(items[i]!) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

async function check(db: Db, sessionId: string, signal: AbortSignal): Promise<ImportPreview> {
  const preview = imp.preview(db, sessionId)
  const groups = rowGroups(preview.rows, existingUncategorised(db, preview.accountId)).slice(0, MAX_GROUPS)
  if (!groups.length && !preview.rows.some((r) => r.status === 'problem' || r.status === 'possible_duplicate') && preview.mapping) {
    const name = activeProvider(db).preset.assistantName
    throw new AppError('assistant.nothing_to_check', `There is nothing for ${name} to check: every row is already in Kasboek and no transactions of this account are uncategorised.`)
  }
  const provider = activeProvider(db)
  requireConfigured(provider)
  const name = provider.preset.assistantName
  const parts = batches(groups).map((b, _i, all) => ({ ...b, of: all.length }))
  let done = 0
  const progress = (): void => broadcast({ type: 'import.checkProgress', sessionId, groupsDone: done, groupsTotal: groups.length, partsTotal: parts.length })
  progress()
  const results = await pool(parts, PARALLEL, async (batch) => {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort('timeout'), limitMs())
    try {
      const text = await callModel(db, provider, buildContext(db, preview, batch), AbortSignal.any([signal, timeout.signal]))
      const plan = parsePlan(text, name)
      done += batch.groups.length
      progress()
      return { batch, plan }
    } catch (err) {
      if (signal.aborted) throw err
      if (timeout.signal.aborted)
        throw new AppError('assistant.timeout', `${name} took longer than ${TIME_LIMIT_MS / 60_000} minutes for part ${batch.n} and was stopped. Try again, or pick a faster model for CSV checks in Settings → Assistant.`)
      throw err
    } finally {
      clearTimeout(timer)
    }
  })
  if (signal.aborted) throw new AppError('assistant.cancelled', 'Check stopped.')
  const finished = results.flatMap((r) => (r.ok ? [r.value] : []))
  const failed = parts.filter((_, i) => !results[i]!.ok)
  if (!finished.length) {
    const first = results.find((r) => !r.ok) as { ok: false; error: unknown }
    throw first.error
  }
  const plan = mergePlans(finished)
  // Parts that failed are left out; what the others found is kept.
  const lost = failed.map((b) => (b.first ? `part ${b.n} (with the column check)` : `part ${b.n}`))
  if (lost.length) plan.notes.unshift(`${lost.length} of ${parts.length} parts couldn’t be checked (${lost.join(', ')}); run Check again to try them.`)
  return applyPlan(db, preview, groups, plan, name)
}

/** One model call that returns the plan as JSON text. */
async function callModel(db: Db, provider: ReturnType<typeof activeProvider>, context: string, signal: AbortSignal): Promise<string> {
  const name = provider.preset.assistantName
  if (provider.preset.id !== 'anthropic') {
    try {
      return await openai.json(provider, { system: INSTRUCTIONS, user: context, schema: z.toJSONSchema(Plan) as Record<string, unknown>, maxTokens: 32000, signal })
    } catch (err) {
      if (signal.aborted) throw err
      throw err instanceof AppError ? err : new AppError('assistant.failed', openai.explainProviderError(err, name))
    }
  }
  const settings = getSettings(db)
  const params = modelParams(settings.csvModel, settings.csvEffort)
  let text = ''
  try {
    const stream = client(db).beta.messages.stream(
      {
        ...params,
        max_tokens: 32000,
        output_config: { ...params.output_config, format: betaZodOutputFormat(Plan) },
        system: INSTRUCTIONS,
        messages: [{ role: 'user', content: context }]
      },
      { signal }
    )
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') throw new AppError('assistant.refused', `${name} declined to check this file.`)
    if (message.stop_reason === 'max_tokens') throw new AppError('assistant.too_long', 'This part of the file was too large for one answer. Try again, or a shorter export.')
    for (const b of message.content) if (b.type === 'text') text += b.text
  } catch (err) {
    if (signal.aborted) throw err
    throw err instanceof AppError ? err : new AppError('assistant.failed', explainError(err))
  }
  return text
}
