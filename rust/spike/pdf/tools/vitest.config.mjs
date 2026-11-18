// Runs corpus.run.ts under vitest only to reuse the repo's TypeScript test helpers; not part of the repo's test suite.
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../../..')
export default {
  root: import.meta.dirname,
  resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@core': resolve(root, 'src/core') } },
  server: { fs: { strict: false } },
  test: { include: ['*.run.ts'], environment: 'node', pool: 'forks' }
}
