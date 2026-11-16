/** Pure helpers for updates: comparing versions and picking this computer's release file. */
import type { UpdateKind } from '@shared/types'

/** "0.11.2" > "0.11.1"; a leading "v" and anything after "-" are ignored. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** How this copy of Kasboek was installed, and so which release file it needs. */
export function installKind(platform = process.platform, env = process.env): UpdateKind | null {
  if (platform === 'win32') return 'msi'
  if (platform === 'darwin') return 'dmg'
  if (platform === 'linux') return env['APPIMAGE'] ? 'appimage' : 'deb'
  return null
}

/** The release file for this system and processor, by the names the build gives them. */
export function pickAsset<T extends { name: string }>(assets: T[], kind: UpdateKind, arch = process.arch): T | null {
  const a = arch === 'arm64' ? '(arm64|aarch64)' : '(x64|x86_64|amd64)'
  const pattern = { msi: `-win-${a}\\.msi$`, dmg: `-mac-${a}\\.dmg$`, appimage: `-${a}\\.AppImage$`, deb: `[-_]${a}\\.deb$` }[kind]
  return assets.find((x) => new RegExp(pattern, 'i').test(x.name)) ?? null
}

/** Release file names are written to disk and into the Windows install script: letters, digits, dot, dash and underscore only. */
export const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/

export function safeAssetName(name: string): boolean {
  return SAFE_ASSET_NAME.test(name) && name !== '.' && name !== '..'
}

/** The SHA-256 for `name` from a SHA256SUMS file: lines of `<hash>  <name>` or `<hash> *<name>`, the name compared whole. */
export function checksumFromSums(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (m && m[2] === name) return m[1]!.toLowerCase()
  }
  return null
}
