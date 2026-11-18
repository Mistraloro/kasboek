// Reference screenshots of the current Electron renderer (out/renderer, built with `npm run build`).
// The renderer runs in Chromium with `window.kasboek` stubbed from tools/fixtures.json and a fixed clock.
//
// Usage: node tools/reference.mjs <outDir> [rendererDir]
// Output: <outDir>/ref-<screen>-<theme>.png (1280x820, scale 1) and <outDir>/ref-<screen>-<theme>.json (DOM boxes)
//   screens: lock-password, lock-hello, overview, overview-bottom (main scrolled to the end)
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] ?? 'ref')
const renderer = resolve(process.argv[3] ?? join(here, '..', '..', '..', '..', 'out', 'renderer'))
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'))
const { chromium } = createRequire(import.meta.url)('playwright')
mkdirSync(outDir, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = createServer((req, res) => {
  const file = join(renderer, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(renderer) || !existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const SCREENS = {
  'lock-password': { 'auth.status': { state: 'locked', mode: 'password', device: null } },
  'lock-hello': { 'auth.status': { state: 'locked', mode: 'device', device: 'windows-hello' } },
  overview: { 'auth.status': { state: 'unlocked', mode: 'password', device: null } },
  'overview-bottom': { 'auth.status': { state: 'unlocked', mode: 'password', device: null } }
}

// The page sees the same bridge as the preload script: invoke(op, input) -> { ok, data }, onEvent(listener) -> off.
const stub = ({ data }) => {
  window.kasboek = {
    invoke: async (op) => (op in data ? { ok: true, data: structuredClone(data[op]) } : { ok: true, data: { ok: true } }),
    onEvent: () => () => {}
  }
}

// Playwright hides scrollbars by default; the app shows its own 10px styled ones.
const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
for (const theme of ['light', 'dark']) {
  for (const [screen, patch] of Object.entries(SCREENS)) {
    const data = structuredClone(fixtures)
    data['prefs.get'].theme = theme
    for (const [op, p] of Object.entries(patch)) Object.assign(data[op], p)
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: theme })
    const page = await ctx.newPage()
    await page.clock.setFixedTime(new Date(2026, 2, 15, 12, 0, 0))
    await page.addInitScript(stub, { data })
    await page.goto(url)
    await page.waitForSelector(screen.startsWith('overview') ? 'main h1' : 'form')
    await page.evaluate(() => document.fonts.ready)
    // No blinking caret in the shots.
    await page.addStyleTag({ content: '* { caret-color: transparent !important; }' })
    if (screen === 'overview-bottom') await page.evaluate(() => document.querySelector('main').scrollTo({ top: 1e6 }))
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(outDir, `ref-${screen}-${theme}.png`) })
    const boxes = await page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
      const out = {}
      const q = (name, sel) => { const l = [...document.querySelectorAll(sel)]; if (l.length) out[name] = l.map((e) => ({ text: (e.textContent ?? '').trim().slice(0, 30), ...r(e) })) }
      q('aside', 'aside'); q('h1', 'h1'); q('h2', 'h2'); q('section', 'section'); q('button', 'button'); q('input', 'input'); q('label', 'label'); q('main', 'main'); q('svg', 'svg'); q('p', 'p'); q('li', 'li'); q('span', 'main span, aside span, header span'); q('ol', 'ol')
      out.mainScroll = [...document.querySelectorAll('main')].map((m) => ({ scrollHeight: m.scrollHeight, clientHeight: m.clientHeight, clientWidth: m.clientWidth }))
      return out
    })
    writeFileSync(join(outDir, `ref-${screen}-${theme}.json`), JSON.stringify(boxes, null, 1))
    await ctx.close()
  }
}
await browser.close()
server.close()
console.log('reference screenshots in', outDir)
