// Lists translation keys used in the renderer but missing from en.json (and unused ones).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const en = JSON.parse(readFileSync('src/renderer/src/i18n/locales/en.json', 'utf8'))
const flat = {}
const walk = (o, p = '') => Object.entries(o).forEach(([k, v]) => (typeof v === 'object' ? walk(v, p + k + '.') : (flat[p + k] = v)))
walk(en)
const files = []
const scan = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? scan(p) : /\.tsx?$/.test(f) && files.push(p) })
scan('src/renderer/src')
const used = new Set()
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*['`]([a-zA-Z0-9_.]+)['`]/g)) used.add(m[1])
const plural = (k) => flat[k] !== undefined || flat[k + '_one'] !== undefined
const missing = [...used].filter((k) => !plural(k) && !k.endsWith('.'))
console.log('missing:', missing.sort().join('\n'))
if (process.argv.includes('--strict') && missing.length) process.exit(1)

// Every translation: same keys as English (regional variants may hold only a subset), the same
// {{placeholders}}, and nothing English doesn't have.
const PARTIAL = new Set(['es-419', 'pt-BR'])
const dir = 'src/renderer/src/i18n/locales'
const flatOf = (o, p = '', out = {}) => (Object.entries(o).forEach(([k, v]) => (typeof v === 'object' ? flatOf(v, p + k + '.', out) : (out[p + k] = v))), out)
const vars = (s) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',')
let problems = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  const code = file.replace(/\.json$/, '')
  const tr = flatOf(JSON.parse(readFileSync(join(dir, file), 'utf8')))
  const report = (msg) => (problems++, console.log(`${code}: ${msg}`))
  for (const k of Object.keys(tr)) {
    // A translation may add plural forms English doesn't need (e.g. _many).
    const base = k.replace(/_(zero|one|two|few|many|other)$/, '')
    if (flat[k] === undefined && flat[base + '_other'] === undefined) report(`extra key ${k}`)
    else if (flat[k] !== undefined && vars(flat[k]) !== vars(tr[k]) && !(k.endsWith('_one') && vars(tr[k]) === '' )) report(`placeholders differ in ${k}: "${tr[k]}"`)
  }
  if (!PARTIAL.has(code)) for (const k of Object.keys(flat)) if (tr[k] === undefined) report(`missing ${k}`)
}
console.log('translation problems:', problems)
if (process.argv.includes('--strict') && problems) process.exit(1)
