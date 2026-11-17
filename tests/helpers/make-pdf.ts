import { deflateSync } from 'node:zlib'

export interface PdfPageSpec {
  width?: number
  height?: number
  /** Turns the page a quarter, clockwise (a landscape page stored upright). */
  rotate?: 90 | 180 | 270
  /** Text pieces: x to the right and y upward from the page bottom, like pdf.js reports them (before any turning). `turned` writes the text upward instead of to the right. */
  texts?: { x: number; y: number; text: string; size?: number; turned?: boolean }[]
}

export interface PdfOptions {
  /** Compress the content streams with FlateDecode. */
  flate?: boolean
  /** Adds an encryption dictionary (the file can't be opened without a password). */
  encrypted?: boolean
  /** Replaces the first page's content stream with this many zero bytes (a decompression bomb when combined with `flate`). */
  filler?: number
}

const escapeText = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`)

/** A small, valid PDF 1.4 file: a Helvetica font (not embedded) and the given text on each page. */
export function makePdf(pages: PdfPageSpec[], opts: PdfOptions = {}): Uint8Array {
  const objects: (Buffer | string)[] = []
  // 1 = catalog, 2 = page tree, 3 = font, then page and content objects in pairs.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  pages.forEach((p, i) => {
    const pageId = 4 + i * 2
    const body =
      opts.filler && i === 0
        ? Buffer.alloc(opts.filler)
        : Buffer.from((p.texts ?? []).map((t) => `BT /F1 ${t.size ?? 9} Tf ${t.turned ? `0 1 -1 0 ${t.x} ${t.y} Tm` : `${t.x} ${t.y} Td`} (${escapeText(t.text)}) Tj ET`).join('\n'), 'latin1')
    const data = opts.flate ? deflateSync(body) : body
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width ?? 595} ${p.height ?? 842}]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    objects[pageId + 1] = Buffer.concat([
      Buffer.from(`<< /Length ${data.length}${opts.flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
      data,
      Buffer.from('\nendstream')
    ])
  })
  const encryptId = objects.length
  if (opts.encrypted) objects[encryptId] = `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  let offset = chunks[0]!.length
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = offset
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`), Buffer.from(objects[id]!), Buffer.from('\nendobj\n')])
    chunks.push(chunk)
    offset += chunk.length
  }
  const xref = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R${opts.encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : ''} >>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(Buffer.from(xref + trailer))
  return new Uint8Array(Buffer.concat(chunks))
}
