import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Everything of the assistant that the page shows (the panel and its toggle, review and tips buttons, checks and consent dialogs,
 * its settings, texts and tour steps) has to disappear when "Use the assistant" is off (assistantEnabled). This scans the renderer
 * the way tests/hide-numbers.test.ts does: a file that shows assistant UI must be gated, directly or through the file that renders it.
 */
const root = join(__dirname, '../src/renderer/src')
const files: string[] = []
const walk = (d: string): void => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) && files.push(join(d, f))))
walk(root)
const rel = (f: string): string => f.slice(root.length + 1).replace(/\\/g, '/')
const source = new Map(files.map((f) => [rel(f), readFileSync(f, 'utf8')]))

/** Lines that show or start something of the assistant. */
const markers: RegExp[] = [
  /<AssistantPanel\b/,
  /\bt\(\s*['`](assistant|memory|permissions|ai)\./,
  /\bt\(\s*['`]insights\.(ask|get|writing|writtenBy|setup|refresh|stop|runningOther|consent)/,
  /\bt\(\s*['`]import\.(assist|checkWithClaude|categoriseExisting|checkPrivacy|claudeOff|checking|checked|stopCheck|lockedWhileAssisting|source\.assistant|pdf\.ai|pdf\.readBy|consent)/,
  /\bt\(\s*['`]overview\.review/,
  /\bt\(\s*['`]welcome\.(ai|provider|privacy|keySaved|local)/,
  /\bcall\(\s*['`](assistant|memory)\./,
  /\bcall\(\s*['`]import\.(assist|pdfAssist)/,
  /\bcall\(\s*['`]insights\.(run|preview|cancel|status)/,
  /kasboek:open-assistant/
]
/** The only lines that may show assistant text without the gate. */
const allowedLines: [string, RegExp, string][] = [
  ['pages/SettingsClaude.tsx', /t\('assistant\.enabled(Hint)?'\)/, 'the switch itself'],
  ['pages/SettingsClaude.tsx', /call\('assistant\.configure', \{ mcpEnabled \}\)/, 'the Claude apps (MCP) switch, a separate integration'],
  ['components/McpRequests.tsx', /t\('assistant\.(approve|decline)'\)/, 'approving a change a Claude app (MCP) asked for'],
  ['lib/error-message.ts', /ai\.neutralName/, 'the neutral wording inside an error text, not assistant UI'],
  ['pages/Welcome.tsx', /call\('assistant\.configure', \{ mcpEnabled \}\)/, 'the Claude apps (MCP) step']
]
/** Files that are only ever rendered by another file, which holds the gate: the child, its parent and what the parent renders. */
const gatedByParent: Record<string, { parent: string; renders: string[] }> = {
  'components/AssistantPanel.tsx': { parent: 'App.tsx', renders: ['<AssistantPanel'] },
  'pages/SettingsClaude.tsx': { parent: 'pages/Settings.tsx', renders: ['<ClaudeSection', '<PermissionsSection'] },
  'pages/SettingsMemory.tsx': { parent: 'pages/Settings.tsx', renders: ['<MemorySection'] },
  'components/ModelPicker.tsx': { parent: 'pages/SettingsClaude.tsx', renders: ['<ModelPicker'] },
  'pages/import-parts/ConsentModals.tsx': { parent: 'pages/import-parts/PreviewView.tsx', renders: ['<CheckConsentModal', '<PdfConsentModal'] },
  'pages/import-parts/CheckSummaryCard.tsx': { parent: 'pages/import-parts/PreviewView.tsx', renders: ['<CheckSummaryCard'] }
}
/** What counts as the gate in a file: the setting, its hook, or the assistant's state, which is null while it is off. */
const GATE = /\bassistantEnabled\b|\buseAssistantEnabled\(\)|\buseAssistant\(\)/

function gated(file: string, seen = new Set<string>()): boolean {
  const via = gatedByParent[file]
  if (!via) return GATE.test(source.get(file) ?? '')
  if (seen.has(file)) return false
  seen.add(file)
  const parent = source.get(via.parent) ?? ''
  return via.renders.every((name) => parent.includes(name)) && gated(via.parent, seen)
}

describe('the assistant is off: nothing of it is shown', () => {
  it('finds the renderer', () => {
    expect(source.has('App.tsx')).toBe(true)
    expect(files.length).toBeGreaterThan(30)
  })

  it('every file that shows assistant UI is gated by assistantEnabled', () => {
    const bad: string[] = []
    for (const [file, text] of source) {
      text.split(/\r?\n/).forEach((line, i) => {
        if (!markers.some((m) => m.test(line))) return
        if (allowedLines.some(([f, re]) => f === file && re.test(line))) return
        if (!gated(file)) bad.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('the files that rely on a parent really are rendered by it', () => {
    for (const [file, via] of Object.entries(gatedByParent)) {
      expect(source.has(file), file).toBe(true)
      expect(gated(file), `${file} through ${via.parent}`).toBe(true)
    }
  })

  it('the panel and its toggle in the top bar are rendered only with the gate on the same line or block', () => {
    const app = source.get('App.tsx')!
    expect(app).toMatch(/assistantEnabled && assistantOpen && <AssistantPanel/)
    expect(app).toMatch(/\{assistantEnabled && \(\s*<button[^>]*\s+type="button"\s+data-tour="assistant"/)
  })

  it('useAssistant, which most buttons read, gives nothing while the assistant is off and does not ask the main process', () => {
    const panel = source.get('components/AssistantPanel.tsx')!
    const hook = panel.slice(panel.indexOf('export function useAssistant()'), panel.indexOf('export function Rich'))
    expect(hook).toContain('useAssistantEnabled()')
    expect(hook).toMatch(/if \(!assistantEnabled\) \{\s*setStatus\(null\)\s*return\s*\}/)
    expect(hook).toContain('return assistantEnabled ? status : null')
  })

  it('no page context is published while the assistant is off', () => {
    const ctx = source.get('lib/page-context.ts')!
    expect(ctx).toContain('useAssistantEnabled()')
    expect(ctx).toMatch(/const ctx = assistantEnabled \? page : null/)
  })

  it('the Settings tab shows only the switch and the Claude apps when it is off', () => {
    const settings = source.get('pages/Settings.tsx')!
    expect(settings).toMatch(/<AssistantSwitchSection \/>\s*\{assistantEnabled && \(\s*<>\s*<ClaudeSection \/>\s*<PermissionsSection \/>\s*<MemorySection \/>\s*<\/>\s*\)\}\s*<ConnectedAppsSection \/>/)
  })

  it('the tour and the welcome window skip their assistant steps', () => {
    expect(source.get('components/Tour.tsx')).toMatch(/assistantEnabled \? STEPS : STEPS\.filter\(\(x\) => x\.id !== 'assistant'\)/)
    expect(source.get('pages/Welcome.tsx')).toMatch(/assistantEnabled \? STEPS : STEPS\.filter\(\(x\) => x !== 'assistant'\)/)
  })

  it('the guard itself notices an ungated file', () => {
    // A made-up file that shows an assistant button with no gate would be reported.
    const line = "<Button onClick={() => void call('assistant.send', { text })}>{t('assistant.send')}</Button>"
    expect(markers.some((m) => m.test(line))).toBe(true)
    expect(GATE.test(line)).toBe(false)
  })
})
