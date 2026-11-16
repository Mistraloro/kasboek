import { describe, expect, it } from 'vitest'
import { codeEntryState, isClaudeDesktopProcess } from '@core/mcp-config'

describe('which claude.exe is Claude Desktop', () => {
  it('tells Claude Desktop from Claude Code by its folder', () => {
    expect(isClaudeDesktopProcess('C:\\Users\\Jan\\AppData\\Local\\AnthropicClaude\\app-0.14.1\\claude.exe')).toBe(true)
    expect(isClaudeDesktopProcess('C:\\Program Files\\WindowsApps\\Claude_0.14.1.0_x64__pzs8sxrjxfjjc\\app\\claude.exe')).toBe(true)
    expect(isClaudeDesktopProcess('C:\\Users\\Jan\\.local\\bin\\claude.exe')).toBe(false)
    expect(isClaudeDesktopProcess('C:\\Users\\Jan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')).toBe(false)
  })
  it('counts an unreadable path as Claude Desktop (the warning can be skipped)', () => {
    expect(isClaudeDesktopProcess(null)).toBe(true)
  })
})

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
