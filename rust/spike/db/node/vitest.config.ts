import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Run from the repository root: npx vitest run --config rust/spike/db/node/vitest.config.ts
const root = resolve(import.meta.dirname, '../../../..')
export default defineConfig({
  root,
  resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@core': resolve(root, 'src/core') } },
  define: { __BUILD_COMMIT__: JSON.stringify('spike') },
  test: { include: ['rust/spike/db/node/*.spec.ts'], environment: 'node', pool: 'forks', testTimeout: 120_000 }
})
