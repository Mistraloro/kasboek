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
