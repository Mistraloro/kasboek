// Shows where the cells of two readers differ for one file. usage: node diff.mjs REF_JSON RUST_JSON REF_BUNDLE [max]
import { readFileSync } from 'node:fs'
const [refFile, rustFile, bundle, max = '12'] = process.argv.slice(2)
const { toLines } = await import(bundle)
const a = toLines(JSON.parse(readFileSync(refFile, 'utf8')))
const b = toLines(JSON.parse(readFileSync(rustFile, 'utf8')))
let shown = 0
for (let i = 0; i < Math.max(a.length, b.length) && shown < Number(max); i++) {
  const x = JSON.stringify(a[i]?.cells.map((c) => [c.text, +c.x0.toFixed(1)]))
  const y = JSON.stringify(b[i]?.cells.map((c) => [c.text, +c.x0.toFixed(1)]))
  if (x !== y || Math.abs((a[i]?.y ?? 0) - (b[i]?.y ?? 0)) > 1.5) {
    shown++
    console.log(`line ${i} page ${a[i]?.page}/${b[i]?.page} y ${a[i]?.y?.toFixed(1)}/${b[i]?.y?.toFixed(1)}\n  pdf.js ${x}\n  rust   ${y}`)
  }
}
