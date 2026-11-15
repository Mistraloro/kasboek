import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** The commit this build is made from, shown next to the version (bug reports can tell builds apart). */
function commit(): string {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'].slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core')
}

export default defineConfig({
  main: {
    resolve: { alias },
    define: { __BUILD_COMMIT__: JSON.stringify(commit()) }
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { ...alias, '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss()]
  }
})
