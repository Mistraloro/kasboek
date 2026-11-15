import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') }
  },
  define: { __BUILD_COMMIT__: JSON.stringify('test') },
  // CI machines (Windows especially) can be slow at creating encrypted databases.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', pool: 'forks', testTimeout: 30_000 }
})
