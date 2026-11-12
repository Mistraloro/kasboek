/** Turning bytes into rows: encoding, delimiter, quoting, and finding the header line. */

/** UTF-8 (with or without BOM), UTF-16 with BOM, otherwise Windows-1252 (common in Belgian bank exports). */
export function decode(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }
  }
}

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF/LF. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field.trim() === '') {
      quoted = true
      field = ''
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

/** Picks the delimiter that gives the most columns, consistently, over the first lines. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30).join('\n')
  let best = ';'
  let bestScore = -1
  for (const d of [';', ',', '\t', '|']) {
    const counts = parseCsv(sample, d).map((r) => r.length)
    if (!counts.length) continue
    const freq = new Map<number, number>()
    counts.forEach((c) => freq.set(c, (freq.get(c) ?? 0) + 1))
    const [mode, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!
    if (mode < 2) continue
    const score = n * 10 + mode
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

export const normHeader = (h: string): string =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, ' ')
    .replace(/[^a-z0-9/ ()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
