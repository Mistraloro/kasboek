/**
 * "Check with Claude" on the import screen. Claude returns a plan (column mapping, row fixes,
 * categories, notes) in a strict JSON format. Code then applies it through the same checks as a
 * manual change, so Claude never writes amounts straight into the database.
 */
import { z } from 'zod'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { Db } from '@core/database'
import { AppError } from '@core/errors'
import { listRules } from '@core/finance'
import * as imp from '@core/import'
import { getSettings } from '@core/settings'
import { mappingSchema } from '@shared/import-mapping'
import type { ImportPreview } from '@shared/types'
import { MAX_GROUPS, Plan, groupKey, parsePlan, uncategorisedGroups } from '@core/assist-plan'
import { client, explainError, modelParams } from './claude'
import * as openai from './openai'
import { activeProvider, requireConfigured } from './provider'



const INSTRUCTIONS = `You check a bank CSV export before it is imported into a personal budget app (Belgium; banks such as Argenta, Hello bank!, Keytrade Bank; Dutch/French/English headers; dates usually DD/MM/YYYY; decimal comma).

You get the raw cells, the column mapping the app detected, the rows it couldn't read or flagged, and the categories. Return a plan:
- mapping: only if the current mapping is wrong or missing, else null. Column numbers are zero-based indexes into the header row. headerRow is the index of the header line among all lines. Prefer a single signed amount column; use debit/credit only when the file has them. invertSign only if money out is positive in this file.
- fixes: only for rows whose correct value is clear from the raw cells. action "fix" with a corrected bookingDate (YYYY-MM-DD), amountCents (integer, negative = money out) or description; "skip" for lines that are not transactions (totals, opening/closing balance, repeated headers, refused payments); "include" only for a row flagged as duplicate that is clearly a separate real transaction. Set fields you don't change to null. reason: a few words.
- categories: uncategorised transactions come in groups (same counterparty or description, same direction). Give each group a category id from the list, one entry per group; the app applies it to every row in the group. Most groups have an obvious category (supermarkets, energy, telecom, rent, salary, restaurants, fuel, insurance, …): categorise every group where one fits, and leave out a group only if you really can't tell. Transfers between the person's own accounts go in a transfer category, not spending. Use only the category ids given.
- notes: 1 to 5 short sentences for the person: what you checked, what you changed, anything they should look at. Plain English.
Never invent amounts or dates that are not supported by the raw cells.`

function buildContext(db: Db, preview: ImportPreview): string {
  const raw = imp.rawWindow(preview.sessionId, 0, 25)
  const flagged = preview.rows.filter((r) => r.status !== 'ready').slice(0, 60)
  const flaggedRaw = flagged.map((r) => ({ index: r.index, status: r.status, issues: r.issues, cells: imp.rawWindow(preview.sessionId, r.index, 1).rows[0]?.cells }))
  const groups = uncategorisedGroups(preview.rows)
    .slice(0, MAX_GROUPS)
    .map((g, i) => `${i} | ${g.rows.length} | ${g.sign} | ${g.example.amountCents} | ${g.example.counterpartyName ?? ''} | ${g.example.description.slice(0, 70)}`)
  const categories = (db.prepare('SELECT id, name, kind FROM categories WHERE archived = 0 ORDER BY kind, name').all() as { id: number; name: string; kind: string }[]).map((c) => `${c.id}: ${c.name} (${c.kind})`)
  const account = db.prepare('SELECT name, currency, bank, iban FROM accounts WHERE id = ?').get(preview.accountId)
  return JSON.stringify(
    {
      account,
      fileName: preview.fileName,
      recognisedLayout: preview.layout,
      delimiter: preview.mapping?.delimiter,
      currentMapping: preview.mapping,
      stats: preview.stats,
      linesAboveHeader: raw.preamble,
      header: raw.header.map((h, i) => `${i}: ${h}`),
      firstRows: raw.rows,
      flaggedRows: flaggedRaw,
      uncategorisedGroups: { format: 'group | rows | in/out | example amountCents | counterparty | description', groups },
      categories,
      rules: listRules(db).map((r) => `${r.field} contains "${r.pattern}" → ${r.categoryId}`)
    },
    null,
    1
  )
}

function applyPlan(db: Db, preview: ImportPreview, plan: Plan, name: string): ImportPreview {
  const notes = [...plan.notes.slice(0, 6)]
  // The groups as the model saw them, before any column change.
  const groupKeys = uncategorisedGroups(preview.rows).slice(0, MAX_GROUPS).map((g) => g.key)
  let current = preview
  if (plan.mapping && preview.mapping) {
    const strip = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T
    const candidate = { ...plan.mapping, delimiter: preview.mapping.delimiter, columns: strip(plan.mapping.columns) }
    const parsed = mappingSchema.safeParse(candidate)
    try {
      if (!parsed.success) throw new Error('invalid')
      const next = imp.remap(db, preview.sessionId, parsed.data, 'assistant')
      // Keep Claude's mapping only if it doesn't make things worse.
      if (next.stats.ready + next.stats.duplicates < preview.stats.ready + preview.stats.duplicates) {
        current = imp.remap(db, preview.sessionId, preview.mapping, preview.mappingSource)
        notes.push(`${name} suggested different columns, but they read fewer rows, so the detected columns were kept.`)
      } else current = next
    } catch {
      notes.push(`${name}’s column suggestion didn’t fit this file, so the detected columns were kept.`)
    }
  } else if (plan.mapping && !preview.mapping) {
    const parsed = mappingSchema.safeParse({ ...plan.mapping, delimiter: ';', columns: Object.fromEntries(Object.entries(plan.mapping.columns).filter(([, v]) => v !== null)) })
    if (parsed.success) {
      try {
        current = imp.remap(db, preview.sessionId, parsed.data, 'assistant')
      } catch {
        notes.push(`${name}’s column suggestion didn’t fit this file.`)
      }
    }
  }

  const maxIndex = current.rows.length - 1
  const validCats = new Set((db.prepare('SELECT id FROM categories').all() as { id: number }[]).map((c) => c.id))
  const changes: Parameters<typeof imp.updateRows>[2] = []
  for (const f of plan.fixes) {
    if (f.index < 0 || f.index > maxIndex) continue
    const note = f.reason.slice(0, 200)
    if (f.action === 'skip') changes.push({ index: f.index, decided: 'skip', note })
    else if (f.action === 'include') changes.push({ index: f.index, decided: 'include', note })
    else {
      const c: Parameters<typeof imp.updateRows>[2][number] = { index: f.index, note }
      if (f.bookingDate && /^\d{4}-\d{2}-\d{2}$/.test(f.bookingDate) && !Number.isNaN(Date.parse(f.bookingDate))) c.bookingDate = f.bookingDate
      if (f.amountCents !== null && Number.isSafeInteger(f.amountCents) && f.amountCents !== 0) c.amountCents = f.amountCents
      if (f.description?.trim()) c.description = f.description.trim().slice(0, 300)
      if (Object.keys(c).length > 2) changes.push(c)
    }
  }
  const byKey = new Map<string, number>()
  for (const c of plan.categories) {
    const key = groupKeys[c.group]
    if (key !== undefined && validCats.has(c.categoryId)) byKey.set(key, c.categoryId)
  }
  const fixed = new Set(changes.map((c) => c.index))
  for (const r of current.rows) {
    if (r.status !== 'ready' || r.categoryId !== null || fixed.has(r.index)) continue
    const categoryId = byKey.get(groupKey(r))
    if (categoryId !== undefined) changes.push({ index: r.index, categoryId, categorySource: 'assistant' })
  }
  const categorised = changes.filter((c) => c.categorySource === 'assistant').length
  if (categorised) notes.push(`${name} set a category for ${categorised} transaction${categorised === 1 ? '' : 's'}; check them before importing.`)
  if (changes.length) current = imp.updateRows(db, preview.sessionId, changes)
  imp.addNotes(preview.sessionId, notes)
  return imp.preview(db, preview.sessionId)
}

/** A check that runs too long is stopped, so the import screen never waits forever. */
const TIME_LIMIT_MS = 4 * 60_000
const running = new Map<string, AbortController>()

/** Stops a running check for this import (the "Stop" button). */
export function cancelAssist(sessionId: string): void {
  running.get(sessionId)?.abort('cancelled')
}

export async function assistImport(db: Db, sessionId: string): Promise<ImportPreview> {
  running.get(sessionId)?.abort('cancelled')
  const controller = new AbortController()
  running.set(sessionId, controller)
  const timer = setTimeout(() => controller.abort('timeout'), TIME_LIMIT_MS)
  try {
    return await check(db, sessionId, controller.signal)
  } catch (err) {
    if (!controller.signal.aborted) throw err
    const name = activeProvider(db).preset.assistantName
    if (controller.signal.reason === 'timeout')
      throw new AppError('assistant.timeout', `${name} took longer than ${TIME_LIMIT_MS / 60_000} minutes and was stopped. Try again, or pick a faster model for CSV checks in Settings → Assistant.`)
    throw new AppError('assistant.cancelled', 'Check stopped.')
  } finally {
    clearTimeout(timer)
    if (running.get(sessionId) === controller) running.delete(sessionId)
  }
}

async function check(db: Db, sessionId: string, signal: AbortSignal): Promise<ImportPreview> {
  const preview = imp.preview(db, sessionId)
  const settings = getSettings(db)
  const provider = activeProvider(db)
  requireConfigured(provider)
  const name = provider.preset.assistantName
  let text = ''
  if (provider.preset.id !== 'anthropic') {
    try {
      text = await openai.json(provider, { system: INSTRUCTIONS, user: buildContext(db, preview), schema: z.toJSONSchema(Plan) as Record<string, unknown>, maxTokens: 16000, signal })
    } catch (err) {
      if (signal.aborted) throw err
      throw err instanceof AppError ? err : new AppError('assistant.failed', openai.explainProviderError(err, name))
    }
    return applyPlan(db, preview, parsePlan(text, name), name)
  }
  const params = modelParams(settings.csvModel, settings.csvEffort)
  try {
    const stream = client(db).beta.messages.stream({
      ...params,
      max_tokens: 32000,
      output_config: { ...params.output_config, format: betaZodOutputFormat(Plan) },
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: buildContext(db, preview) }]
    }, { signal })
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') throw new AppError('assistant.refused', `${name} declined to check this file.`)
    if (message.stop_reason === 'max_tokens') throw new AppError('assistant.too_long', 'This file is too large for one check. Try a shorter export.')
    for (const b of message.content) if (b.type === 'text') text += b.text
  } catch (err) {
    if (signal.aborted) throw err
    throw err instanceof AppError ? err : new AppError('assistant.failed', explainError(err))
  }
  return applyPlan(db, preview, parsePlan(text, name), name)
}



