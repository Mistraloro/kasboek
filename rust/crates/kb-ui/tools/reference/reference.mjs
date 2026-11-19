// Renders every case of tools/cases.json with the real React components (the harness bundle) in Chromium and writes
// <outDir>/ref-<case>-<theme>.png (case size, scale 1) and ref-<case>-<theme>.json (DOM boxes).
// Usage: node tools/reference/reference.mjs <outDir> <harnessDir> [case ...]
// Playwright must be resolvable from the repo root (it is installed there); chromium.launch() takes no options.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..', '..', '..')
const outDir = resolve(process.argv[2] ?? 'ref')
const harness = resolve(process.argv[3] ?? 'harness-out')
const only = process.argv.slice(4)
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'))
const cases = JSON.parse(readFileSync(join(here, '..', 'cases.json'), 'utf8'))
const { chromium } = createRequire(join(root, 'package.json'))('playwright')
mkdirSync(outDir, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = createServer((req, res) => {
  const file = join(harness, req.url === '/' ? 'harness.html' : decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(harness) || !existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/harness.html`

const stub = ({ data }) => {
  window.kasboek = {
    invoke: async (op) => (op in data ? { ok: true, data: structuredClone(data[op]) } : { ok: true, data: { ok: true } }),
    onEvent: () => () => {}
  }
}

// Cases the Slint gallery has but the renderer has no component for (native checkbox/radio, new in the port).
const SKIP = new Set(['choice', 'progress', 'select-open'])

// What the state markers mean: forced pseudo classes on the marked element (or a descendant).
const FORCE = { hover: 'hover', focus: 'focus', 'focus-selected': 'focus', 'focus-child': 'focus' }

const browser = await chromium.launch()
for (const theme of ['light', 'dark']) {
  for (const c of cases) {
    if ((only.length && !only.includes(c.name)) || SKIP.has(c.name)) continue
    const data = structuredClone(fixtures)
    data['prefs.get'].theme = theme
    const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: theme })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.error(`[${c.name} ${theme}] page error:`, e.message))
    await page.clock.setFixedTime(new Date(2026, 2, 15, 12, 0, 0))
    await page.addInitScript(stub, { data })
    await page.goto(`${base}?case=${c.name}&theme=${theme}`)
    await page.waitForSelector('#stage')
    await page.evaluate(() => document.fonts.ready)
    await page.addStyleTag({ content: '* { caret-color: transparent !important; transition: none !important; }' })
    await page.waitForTimeout(250)

    // Per-case actions.
    if (c.name === 'password') {
      const eye = page.locator('#held').locator('xpath=..').locator('button')
      const box = await eye.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
    }
    if (c.name === 'monthnav') await page.getByRole('button', { name: 'March 2026' }).click()
    if (c.name === 'modal-ask') await page.keyboard.press('Escape')
    if (c.name === 'date') {
      await page.locator('input').focus()
      await page.keyboard.type('99/99/2026')
      await page.keyboard.press('Tab')
    }
    if (c.name === 'monthbars') {
      // The third month's slot centre: slot = 560/6 user units, scaled to the 552 px wide plot.
      const svg = await page.locator('svg[role=img]').boundingBox()
      await page.mouse.move(svg.x + (svg.width / 6) * 2.5, svg.y + svg.height / 2)
    }
    if (c.name === 'trendline') {
      const svg = await page.locator('svg[role=img]').boundingBox()
      const k = svg.width / 560
      await page.mouse.move(svg.x + (56 + (2 / 6) * 496) * k, svg.y + svg.height / 2)
    }

    // Forced states through CDP.
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 })
    for (const [marker, pseudo] of Object.entries(FORCE)) {
      const sel = marker === 'focus-selected' ? '[data-force=focus-selected] [role=radio][aria-checked=true]' : marker === 'focus-child' ? '[data-force=focus-child] button' : `[data-force=${marker}]`
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: sel })
      for (const nodeId of nodeIds) {
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo === 'focus' ? ['focus', 'focus-visible'] : [pseudo] })
      }
    }
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(outDir, `ref-${c.name}-${theme}.png`) })
    const boxes = await page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
      const out = {}
      for (const sel of ['button', 'input', 'select', 'h1', 'h2', 'h3', 'section', 'svg', 'span', 'p', 'tr', 'th']) {
        const list = [...document.querySelectorAll(`#stage ${sel}, body > div ${sel}`)]
        if (list.length) out[sel] = list.map((e) => ({ text: (e.textContent ?? '').trim().slice(0, 30), ...r(e) }))
      }
      return out
    })
    writeFileSync(join(outDir, `ref-${c.name}-${theme}.json`), JSON.stringify(boxes, null, 1))
    await ctx.close()
  }
}
await browser.close()
server.close()
console.log('reference screenshots in', outDir)
