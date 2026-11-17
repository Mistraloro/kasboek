/**
 * Text of a PDF page as positioned pieces, grouped into lines and cells. No PDF library here: the
 * pieces come from whatever extracted the text.
 */

/** One piece of text as pdf.js reports it: x to the right, y upward from the page bottom (PDF user space). */
export interface PdfTextItem {
  str: string
  x: number
  y: number
  /** Width of the text. */
  w: number
  /** Font height. */
  h: number
}

export interface PdfText {
  pages: { n: number; width: number; height: number; items: PdfTextItem[] }[]
  pageCount: number
}

/** Text that belongs together on a line, with the horizontal range it occupies. */
export interface PdfCell {
  text: string
  x0: number
  x1: number
}

export interface PdfLine {
  /** Position in reading order over the whole document. */
  id: number
  page: number
  y: number
  /** Height of the page, to tell margins from the body. */
  pageHeight?: number
  cells: PdfCell[]
}

/** Pieces closer than this (times the font height) are one cell. */
const CELL_GAP = 0.3
/** Baselines closer than this (times the median font height) are one line. */
const LINE_TOLERANCE = 0.5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0
}

/** Lines in reading order (top of each page first, left to right), each split into cells. */
export function toLines(t: PdfText): PdfLine[] {
  const lines: PdfLine[] = []
  const pages = [...t.pages].sort((a, b) => a.n - b.n)
  for (const page of pages) {
    const items = page.items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x)
    if (!items.length) continue
    const tolerance = (median(items.map((i) => i.h).filter((h) => h > 0)) || 10) * LINE_TOLERANCE
    const groups: { y: number; items: PdfTextItem[] }[] = []
    for (const item of items) {
      const group = groups.at(-1)
      if (group && Math.abs(group.y - item.y) <= tolerance) {
        group.items.push(item)
        group.y += (item.y - group.y) / group.items.length
      } else groups.push({ y: item.y, items: [item] })
    }
    for (const group of groups) {
      lines.push({ id: lines.length, page: page.n, y: group.y, pageHeight: page.height, cells: toCells(group.items.sort((a, b) => a.x - b.x)) })
    }
  }
  return lines
}

function toCells(items: PdfTextItem[]): PdfCell[] {
  const cells: PdfCell[] = []
  let last: PdfTextItem | null = null
  for (const item of items) {
    const cell = cells.at(-1)
    const gap = last ? item.x - (last.x + last.w) : Infinity
    if (cell && last && gap < CELL_GAP * item.h) {
      // Pieces of one word touch; words are a space apart.
      const space = gap > 0.08 * item.h && !/\s$/.test(last.str) && !/^\s/.test(item.str)
      cell.text += (space ? ' ' : '') + item.str
      cell.x1 = Math.max(cell.x1, item.x + item.w)
    } else cells.push({ text: item.str, x0: item.x, x1: item.x + item.w })
    last = item
  }
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() }))
}
