// Builds the kasboek-mcp helper (tools/kasboek-mcp, Go) for every 64-bit target:
//   build/mcp/<platform>-<arch>/kasboek-mcp[.exe]   (platform/arch as Node/Electron name them)
// Needs Go 1.22+. Static binaries, no runtime, no cgo.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const targets = [
  ['win32', 'x64', 'windows', 'amd64'],
  ['win32', 'arm64', 'windows', 'arm64'],
  ['darwin', 'x64', 'darwin', 'amd64'],
  ['darwin', 'arm64', 'darwin', 'arm64'],
  ['linux', 'x64', 'linux', 'amd64'],
  ['linux', 'arm64', 'linux', 'arm64']
]
const only = process.argv.includes('--host') ? targets.filter(([p, a]) => p === process.platform && a === process.arch) : targets
for (const [platform, arch, goos, goarch] of only) {
  const outDir = resolve('build', 'mcp', `${platform}-${arch}`)
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, platform === 'win32' ? 'kasboek-mcp.exe' : 'kasboek-mcp')
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'], {
    cwd: 'tools/kasboek-mcp',
    stdio: 'inherit',
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
  })
  console.log('built', out)
}
