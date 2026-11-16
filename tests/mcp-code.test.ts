import { describe, expect, it } from 'vitest'
import { codeEntryState } from '@core/mcp-config'

const entry = { command: 'C:\\Users\\Jan\\AppData\\Local\\Programs\\Kasboek\\resources\\kasboek-mcp.exe', args: ['--data-dir', 'C:\\Users\\Jan\\AppData\\Roaming\\Kasboek'] }
const out = (command: string, dir: string): string => `kasboek:\n  Scope: User config\n  Status: ✓ Connected\n  Type: stdio\n  Command: ${command}\n  Args: --data-dir ${dir}\n`

describe('Claude Code entry state', () => {
  it('is current when it starts this helper with this data folder', () => {
    expect(codeEntryState(true, out('c:/users/jan/appdata/local/programs/kasboek/resources/kasboek-mcp.exe', 'C:\\Users\\Jan\\AppData\\Roaming\\Kasboek'), entry)).toBe('current')
  })
  it('is outdated when it points at another helper or data folder', () => {
    expect(codeEntryState(true, out('D:\\Old\\kasboek-mcp.exe', 'C:\\Users\\Jan\\AppData\\Roaming\\Kasboek'), entry)).toBe('outdated')
    expect(codeEntryState(true, out(entry.command, 'C:\\Elsewhere'), entry)).toBe('outdated')
  })
  it('is absent when Claude Code has no Kasboek entry', () => {
    expect(codeEntryState(false, 'No MCP server found with name: kasboek', entry)).toBe('absent')
  })
})
