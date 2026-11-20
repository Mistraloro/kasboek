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
    // Windows runners are the slowest at disk work: two workers there, which stops files starving each other.
    maxWorkers: process.env.CI ? (process.platform === 'win32' ? 2 : '50%') : undefined,
    setupFiles: ['tests/setup.ts'],
    testTimeout: process.env.CI ? 60_000 : 30_000
  }
})
