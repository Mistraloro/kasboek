// Converts the lucide icons the spike needs from lucide-react's icon data into standalone SVG files.
// Usage: node tools/make-icons.mjs   (run from anywhere; reads <repo>/node_modules/lucide-react)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', '..')
const out = join(here, '..', 'assets', 'icons')
mkdirSync(out, { recursive: true })

// file name in lucide-react -> [output name, stroke width]
const icons = [
  ['layout-dashboard', 'layout-dashboard'],
  ['arrow-left-right', 'arrow-left-right'],
  ['target', 'target'],
  ['repeat', 'repeat'],
  ['piggy-bank', 'piggy-bank'],
  ['calendar-range', 'calendar-range'],
  ['trending-up', 'trending-up'],
  ['file-up', 'file-up'],
  ['settings', 'settings'],
  ['lock', 'lock'],
  ['panel-right', 'panel-right'],
  ['sparkles', 'sparkles'],
  ['triangle-exclamation-point', 'triangle-alert'],
  ['tags', 'tags'],
  ['scan-face', 'scan-face'],
  ['eye', 'eye'],
  ['check', 'check', 3]
]

for (const [file, name, sw = 2] of icons) {
  const mod = await import(pathToFileURL(join(root, 'node_modules/lucide-react/dist/esm/icons', `${file}.mjs`)).href)
  const body = mod.__iconData.node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('')
  writeFileSync(
    join(out, `${name}${sw === 2 ? '' : `-${sw}`}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`
  )
}
writeFileSync(
  join(out, 'mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="240 200 520 624" fill="#000"><path d="M492 512 L704 724" stroke="#000" stroke-opacity=".5" stroke-width="120" stroke-linecap="round"/><path d="M492 512 L704 300" stroke="#000" stroke-width="120" stroke-linecap="round"/><rect x="292" y="252" width="120" height="520" rx="60"/></svg>\n`
)
console.log('ok')
