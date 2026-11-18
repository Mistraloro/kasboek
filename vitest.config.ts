import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') }
  },
  define: { __BUILD_COMMIT__: JSON.stringify('test') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // CI machines (Windows especially) are slow at disk and memory work, and 68 files at once starve each other:
    // use half the cores there and allow more time per test.
    maxWorkers: process.env.CI ? '50%' : undefined,
    testTimeout: process.env.CI ? 60_000 : 30_000
  }
})
