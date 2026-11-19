// Bundles harness.tsx (the real renderer components) with the renderer's own Vite plugins (React, Tailwind).
// Usage: node tools/reference/build.mjs <outDir>      (needs `npm ci` at the repo root, nothing else)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..', '..', '..')
const outDir = resolve(process.argv[2] ?? 'harness-out')
const need = createRequire(join(root, 'package.json'))
const load = async (name) => (await import(pathToFileURL(need.resolve(name)).href)).default
const { build } = await import(pathToFileURL(need.resolve('vite')).href)
const react = await load('@vitejs/plugin-react')
const tailwindcss = await load('@tailwindcss/vite')

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': join(root, 'src/shared'), '@core': join(root, 'src/core'), '@renderer': join(root, 'src/renderer/src') } },
  build: { outDir, emptyOutDir: true, rollupOptions: { input: join(here, 'harness.html') } }
})
// Vite keeps the page's path relative to the repo root; put it next to assets/ as harness.html.
const emitted = join(outDir, relative(root, join(here, 'harness.html')))
const up = relative(dirname(emitted), outDir).replaceAll('\\', '/')
writeFileSync(join(outDir, 'harness.html'), readFileSync(emitted, 'utf8').replaceAll(`${up}/assets/`, './assets/'))
console.log('harness bundle in', outDir)
