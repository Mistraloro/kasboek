// Compares the text pdf.js gives (the app's own extractText) with the Rust reader's, per PDF.
// usage: node compare.mjs REF_DIR RUST_DIR REF_BUNDLE  (the dirs hold <name>.json files as written by run-all.sh)
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [refDir, rustDir, bundle] = process.argv.slice(2)
const { toLines, readStatement } = await import(bundle)
const TOL = 1.5
const norm = (s) => s.normalize('NFC').replace(/\s+/g, '')
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)

function cellsOf(t) {
  return toLines(t).map((l) => ({ page: l.page, y: l.y, cells: l.cells }))
}

function compareLines(a, b) {
  // a = pdf.js lines, b = rust lines; same line index only counts when its page and y agree.
  let cellsA = 0, cellsOk = 0, linesOk = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < a.length; i++) cellsA += a[i].cells.length
  for (let i = 0; i < n; i++) {
    if (a[i].page !== b[i].page || Math.abs(a[i].y - b[i].y) > TOL) continue
    let same = a[i].cells.length === b[i].cells.length
    for (let c = 0; c < Math.min(a[i].cells.length, b[i].cells.length); c++) {
      const x = a[i].cells[c], y = b[i].cells[c]
      if (x.text === y.text && Math.abs(x.x0 - y.x0) <= TOL) cellsOk++
      else same = false
    }
    if (same) linesOk++
  }
  return { linesA: a.length, linesB: b.length, linesOk, cellsA, cellsOk }
}

// Item level: every pdf.js item should have a Rust item whose text (without spaces) is the same or contained in it,
// with the start inside the tolerance. Counts differ by design (pdf.js merges show operations, others do not).
function itemMatch(refT, rustT) {
  let total = 0, ok = 0, posOk = 0
  for (const rp of refT.pages) {
    const other = rustT.pages.find((p) => p.n === rp.n)
    const cand = other ? other.items.map((i) => ({ ...i, s: norm(i.str) })) : []
    for (const it of rp.items) {
      const s = norm(it.str)
      if (!s) continue
      total++
      const hit = cand.find((c) => Math.abs(c.y - it.y) <= TOL && c.s.includes(s) && Math.abs(c.x - it.x) <= TOL + 1e9)
      if (hit) {
        ok++
        const off = hit.s.indexOf(s)
        if (off === 0 && Math.abs(hit.x - it.x) <= TOL) posOk++
        else if (off > 0 && Math.abs(hit.x + (hit.w * off) / hit.s.length - it.x) <= TOL * 3) posOk++
      }
    }
  }
  return { total, ok, posOk }
}

const pages = (t) => t.pages.map((p) => p.items.reduce((n, i) => n + i.str.length, 0))
const names = readdirSync(refDir).filter((f) => f.endsWith('.json') && !f.endsWith('.perf.json')).map((f) => f.slice(0, -5)).sort()
const rows = []
for (const name of names) {
  const ref = load(join(refDir, name + '.json'))
  const rust = load(join(rustDir, name + '.json'))
  const perfRef = load(join(refDir, name + '.perf.json'))
  const perfRust = load(join(rustDir, name + '.perf.json'))
  const row = { name, refMs: perfRef?.ms, rustMs: perfRust?.ms, refMb: perfRef?.rssMb, rustMb: perfRust?.rssMb }
  if (ref.error || !rust || rust.error) {
    row.refErr = ref.error
    row.rustErr = rust?.error ?? 'missing'
    row.errorsAgree = ref.error === rust?.error
    rows.push(row)
    continue
  }
  row.pages = ref.pageCount === rust.pageCount
  row.dims = ref.pages.every((p, i) => rust.pages[i] && Math.abs(p.width - rust.pages[i].width) < 0.5 && Math.abs(p.height - rust.pages[i].height) < 0.5)
  row.itemsRef = ref.pages.reduce((n, p) => n + p.items.length, 0)
  row.itemsRust = rust.pages.reduce((n, p) => n + p.items.length, 0)
  const la = cellsOf(ref), lb = cellsOf(rust)
  row.lines = compareLines(la, lb)
  row.textEqual = JSON.stringify(la.map((l) => l.cells.map((c) => norm(c.text)))) === JSON.stringify(lb.map((l) => l.cells.map((c) => norm(c.text))))
  row.item = itemMatch(ref, rust)
  const sa = readStatement(toLines(ref)), sb = readStatement(toLines(rust))
  row.stmtGrid = JSON.stringify(sa.grid) === JSON.stringify(sb.grid)
  row.stmtFull = JSON.stringify(sa) === JSON.stringify(sb)
  row.gridRows = sa.grid.length
  row.gridRowsRust = sb.grid.length
  rows.push(row)
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-')
console.log('name'.padEnd(28), 'dims items(ref/rs) lines ok/n   cells ok/n    item%  pos%  text= grid= full= | ms ref/rs | MB ref/rs')
for (const r of rows) {
  if (r.rustErr || r.refErr) {
    console.log(r.name.padEnd(28), `ERR ref=${r.refErr ?? '-'} rust=${r.rustErr ?? '-'} agree=${r.errorsAgree}`)
    continue
  }
  console.log(
    r.name.padEnd(28),
    String(r.pages && r.dims).padEnd(5),
    `${r.itemsRef}/${r.itemsRust}`.padEnd(11),
    `${r.lines.linesOk}/${r.lines.linesA}`.padEnd(10),
    `${r.lines.cellsOk}/${r.lines.cellsA}`.padEnd(12),
    pct(r.item.ok, r.item.total).padStart(5), pct(r.item.posOk, r.item.total).padStart(5),
    String(r.textEqual).padEnd(6), String(r.stmtGrid).padEnd(5), String(r.stmtFull).padEnd(5),
    '|', `${r.refMs?.toFixed(0)}/${r.rustMs?.toFixed(0)}`.padEnd(9), '|', `${r.refMb?.toFixed(0)}/${r.rustMb?.toFixed(0)}`
  )
}
const ok = rows.filter((r) => !r.rustErr && !r.refErr)
const sum = (f) => ok.reduce((n, r) => n + f(r), 0)
console.log(`\nfiles ${rows.length}, compared ${ok.length}`)
console.log(`cells matched ${pct(sum((r) => r.lines.cellsOk), sum((r) => r.lines.cellsA))}%  lines matched ${pct(sum((r) => r.lines.linesOk), sum((r) => r.lines.linesA))}%`)
console.log(`text equal ${ok.filter((r) => r.textEqual).length}/${ok.length}  grid equal ${ok.filter((r) => r.stmtGrid).length}/${ok.length}  full statement equal ${ok.filter((r) => r.stmtFull).length}/${ok.length}`)
console.log(`ref grids with rows: ${ok.filter((r) => r.gridRows > 1).length}; of those grid equal: ${ok.filter((r) => r.gridRows > 1 && r.stmtGrid).length}`)
