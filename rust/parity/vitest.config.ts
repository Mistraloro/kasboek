import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Run from the repository root: npx vitest run --config rust/parity/vitest.config.ts
// Not part of the app's own test run (vitest.config.ts includes tests/** only).
const root = resolve(import.meta.dirname, '../..')
// The TypeScript the specs compare with. KB_TS_ROOT points at another checkout (for example the release branch while this one is behind it).
const ts = process.env.KB_TS_ROOT ? resolve(process.env.KB_TS_ROOT) : root
export default defineConfig({
  root,
  resolve: { alias: { '@shared': resolve(ts, 'src/shared'), '@core': resolve(ts, 'src/core') } },
  server: { fs: { strict: false } },
  define: { __BUILD_COMMIT__: JSON.stringify('parity') },
  test: { include: ['rust/parity/*.spec.ts'], environment: 'node', pool: 'forks', testTimeout: 120_000, hookTimeout: 120_000 }
})
