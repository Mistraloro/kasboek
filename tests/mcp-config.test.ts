import { describe, expect, it } from 'vitest'
import { desktopEntryState, withKasboek, withoutKasboek } from '@core/mcp-config'

const entry = { command: 'C:\\Users\\x\\AppData\\Local\\Programs\\Kasboek\\resources\\kasboek-mcp.exe', args: ['--data-dir', 'C:\\Users\\x\\AppData\\Roaming\\Kasboek'] }
const existing = JSON.stringify({
  mcpServers: { rea: { command: 'node.exe', args: ['rea.mjs', 'mcp'], env: { JAVA_HOME: 'C:\\jdk' } }, kasboek: { command: 'Kasboek.exe', args: ['--mcp'] } },
  coworkUserFilesPath: 'C:\\Users\\x\\Claude',
  preferences: { sidebarMode: 'epitaxy', nested: { deep: [1, 2, { a: true }] } }
}, null, 2)

describe('Claude Desktop config', () => {
  it('replaces only the kasboek entry and keeps everything else exactly', () => {
    const out = JSON.parse(withKasboek(existing, entry))
    const before = JSON.parse(existing)
    expect(out.mcpServers.kasboek).toEqual(entry)
    expect(out.mcpServers.rea).toEqual(before.mcpServers.rea)
    expect(out.preferences).toEqual(before.preferences)
    expect(out.coworkUserFilesPath).toBe(before.coworkUserFilesPath)
  })
  it('creates the file content when there is none, and handles a BOM', () => {
    expect(JSON.parse(withKasboek(null, entry))).toEqual({ mcpServers: { kasboek: entry } })
    expect(JSON.parse(withKasboek('\uFEFF{"a":1}', entry)).a).toBe(1)
  })
  it('never rewrites a file it cannot read', () => {
    expect(() => withKasboek('{ "mcpServers": { broken', entry)).toThrow(/left it alone/)
    expect(() => withKasboek('{"mcpServers": []}', entry)).toThrow(/left it alone/)
    expect(() => withKasboek('[1,2]', entry)).toThrow(/left it alone/)
  })
  it('reports the state and removes only kasboek', () => {
    expect(desktopEntryState(existing, entry)).toBe('outdated')
    expect(desktopEntryState(withKasboek(existing, entry), entry)).toBe('current')
    expect(desktopEntryState('{}', entry)).toBe('absent')
    const removed = JSON.parse(withoutKasboek(existing))
    expect(removed.mcpServers.kasboek).toBeUndefined()
    expect(removed.mcpServers.rea).toBeTruthy()
  })
})
