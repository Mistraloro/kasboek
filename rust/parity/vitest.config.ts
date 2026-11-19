import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Run from the repository root: npx vitest run --config rust/parity/vitest.config.ts
// Not part of the app's own test run (vitest.config.ts includes tests/** only).
const root = resolve(import.meta.dirname, '../..')
export default defineConfig({
  root,
  resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@core': resolve(root, 'src/core') } },
  define: { __BUILD_COMMIT__: JSON.stringify('parity') },
  test: { include: ['rust/parity/*.spec.ts'], environment: 'node', pool: 'forks', testTimeout: 120_000, hookTimeout: 120_000 }
})
