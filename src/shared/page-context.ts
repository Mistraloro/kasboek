/**
 * What the chat panel tells the assistant about the page the person has open: built by the page from
 * its own data and state (never from the screen). The same shape is checked again in the main process.
 */
import { z } from 'zod'

export const PAGE_CONTEXT_PAGES = ['overview', 'transactions', 'budgets', 'recurring'] as const
export type PageContextPage = (typeof PAGE_CONTEXT_PAGES)[number]

/** At most this many visible rows go to the assistant. */
export const MAX_CONTEXT_ROWS = 50
/** At most this many selected ids go to the assistant. */
export const MAX_CONTEXT_SELECTED = 50

const cell = z.union([z.string().max(300), z.number(), z.null()])

export const PageContextSchema = z
  .object({
    page: z.enum(PAGE_CONTEXT_PAGES),
    /** Active filters and view settings, e.g. month, account, search. Only the ones that are set. */
    filters: z.record(z.string().max(40), cell).refine((o) => Object.keys(o).length <= 12, { message: 'Too many filters.' }),
    /** Ids of the selected items (transactions). */
    selectedIds: z.array(z.number().int()).max(1000),
    /** The id of the item open in a form or detail view. */
    openId: z.number().int().nullable(),
    /** The visible rows, in the order shown. */
    rows: z.array(z.record(z.string().max(40), cell).refine((o) => Object.keys(o).length <= 14, { message: 'Too many columns.' })).max(1000)
  })
  .strict()
export type PageContext = z.infer<typeof PageContextSchema>
