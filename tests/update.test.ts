import { describe, expect, it } from 'vitest'
import { installKind, newer, pickAsset } from '@core/update'

const files = ['Kasboek-0.12.0-win-x64.msi', 'Kasboek-0.12.0-win-arm64.msi', 'Kasboek-0.12.0-mac-arm64.dmg', 'Kasboek-0.12.0-mac-x64.dmg', 'Kasboek-0.12.0-x86_64.AppImage', 'Kasboek-0.12.0-arm64.AppImage', 'Kasboek-0.12.0-amd64.deb', 'Kasboek-0.12.0-arm64.deb', 'SHA256SUMS.txt'].map((name) => ({ name }))

describe('updates', () => {
  it('compares versions', () => {
    expect(newer('v0.12.0', '0.11.2')).toBe(true)
    expect(newer('0.11.10', '0.11.9')).toBe(true)
    expect(newer('v0.11.2', '0.11.2')).toBe(false)
    expect(newer('0.11.1', '0.11.2')).toBe(false)
    expect(newer('1.0', '0.99.99')).toBe(true)
  })

  it('knows how this copy was installed', () => {
    expect(installKind('win32', {})).toBe('msi')
    expect(installKind('darwin', {})).toBe('dmg')
    expect(installKind('linux', { APPIMAGE: '/home/a/Kasboek.AppImage' })).toBe('appimage')
    expect(installKind('linux', {})).toBe('deb')
  })

  it('picks the file for this system and processor', () => {
    expect(pickAsset(files, 'msi', 'x64')?.name).toBe('Kasboek-0.12.0-win-x64.msi')
    expect(pickAsset(files, 'msi', 'arm64')?.name).toBe('Kasboek-0.12.0-win-arm64.msi')
    expect(pickAsset(files, 'dmg', 'arm64')?.name).toBe('Kasboek-0.12.0-mac-arm64.dmg')
    expect(pickAsset(files, 'appimage', 'x64')?.name).toBe('Kasboek-0.12.0-x86_64.AppImage')
    expect(pickAsset(files, 'deb', 'x64')?.name).toBe('Kasboek-0.12.0-amd64.deb')
    expect(pickAsset(files, 'deb', 'arm64')?.name).toBe('Kasboek-0.12.0-arm64.deb')
    expect(pickAsset([{ name: 'Kasboek-0.12.0-win-x64.exe' }], 'msi', 'x64')).toBeNull()
  })
})
