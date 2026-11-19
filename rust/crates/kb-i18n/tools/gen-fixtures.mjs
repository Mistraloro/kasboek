// Writes tests/fixtures/i18next.json: what i18next 27 answers for keys of the app's locale files, in all 8 languages,
// configured as src/renderer/src/i18n/index.ts does. Run from the repo root: node rust/crates/kb-i18n/tools/gen-fixtures.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import i18next from 'i18next'

const here = new URL('../', import.meta.url)
const locales = new URL('../../../../src/renderer/src/i18n/locales/', import.meta.url)
const LANGS = ['en', 'nl', 'fr', 'de', 'es', 'es-419', 'pt-PT', 'pt-BR']
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v; return a }
const resources = {}
for (const l of LANGS) {
  const base = JSON.parse(readFileSync(new URL(`${l}.json`, locales), 'utf8'))
  merge(base, JSON.parse(readFileSync(new URL(`locales/extra.${l}.json`, here), 'utf8')))
  resources[l] = { translation: base }
}
const instance = i18next.createInstance()
await instance.init({
  resources, lng: 'en', fallbackLng: { 'es-419': ['es', 'en'], 'pt-BR': ['pt-PT', 'en'], default: ['en'] },
  interpolation: { escapeValue: false, defaultVariables: { ai: 'Claude', aiCompany: 'Anthropic' } }, returnNull: false
})

const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, `${p}${k}.`) : [`${p}${k}`]))
const SECTIONS = ['app', 'nav', 'auth', 'overview', 'alerts', 'insights', 'monthNav', 'modal', 'fx', 'loading']
const plural = /_(zero|one|two|few|many|other)$/
const keys = new Set()
const pluralKeys = new Set()
for (const l of LANGS) for (const leaf of leaves(resources[l].translation)) {
  if (!SECTIONS.includes(leaf.split('.')[0])) continue
  if (plural.test(leaf)) pluralKeys.add(leaf.replace(plural, '')); else keys.add(leaf)
}
const vars = { name: 'Fresco', spent: '€174,00', budget: '€120,00', pct: 145, percent: 145, s: 30, version: '0.22.0', n: 12, date: '15/11/2026', month: 'November 2026' }
const cases = []
for (const lng of LANGS) {
  const t = instance.getFixedT(lng)
  for (const key of [...keys, 'nope.missing', 'overview']) cases.push([lng, key, null, t(key, vars)])
  for (const key of [...pluralKeys, 'nope.counted'])
    for (const count of [0, 1, 2, 5, 21, 1000000]) cases.push([lng, key, count, t(key, { ...vars, count })])
}
writeFileSync(new URL('../tests/fixtures/i18next.json', import.meta.url), JSON.stringify({ vars, cases }) + '\n')
console.log('cases', cases.length, 'bytes', JSON.stringify({ vars, cases }).length)
