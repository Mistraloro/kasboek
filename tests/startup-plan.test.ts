import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatLogLine,
  isFirstStartOfVersion,
  laterStep,
  LogBuffer,
  MAX_LOG_LINES,
  MAX_MILESTONES,
  milestoneLine,
  opWaitsForSession,
  progressAt,
  PROGRESS_STEPS,
  rotateLog,
  shouldShowMainWindow,
  startGap,
  stepForMilestone,
  stepText
} from '../src/main/startup-plan'

describe('launch window progress', () => {
  it('starts exactly at the step and moves forward over time, but never reaches the next step', () => {
    PROGRESS_STEPS.forEach((step, i) => {
      const next = PROGRESS_STEPS[i + 1]?.at ?? 1
      expect(progressAt(step.id, 0)).toBeCloseTo(step.at, 10)
      let before = progressAt(step.id, 0)
      for (const ms of [200, 1_000, 5_000, 20_000, 120_000]) {
        const now = progressAt(step.id, ms)
        expect(now).toBeGreaterThan(before)
        expect(now).toBeLessThan(next)
        before = now
      }
    })
  })

  it('keeps creeping in a long phase, so it never looks frozen', () => {
    expect(progressAt('main-window-created', 8_000) - progressAt('main-window-created', 4_000)).toBeGreaterThan(0.005)
  })

  it('treats a negative time as zero', () => {
    expect(progressAt('begin', -50)).toBe(progressAt('begin', 0))
  })

  it('has rising steps that end before the full bar, and a text for each', () => {
    const at = PROGRESS_STEPS.map((s) => s.at)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(at[at.length - 1]).toBeLessThan(1)
    for (const s of PROGRESS_STEPS) expect(stepText(s.id)).toBe(s.text)
  })

  it('ignores a step that is earlier than one already reached', () => {
    expect(laterStep('data-opened', 'app-code-loaded')).toBe('data-opened')
    expect(laterStep('data-opened', 'data-opened')).toBe('data-opened')
    expect(laterStep('data-opened', 'prefs-loaded')).toBe('prefs-loaded')
  })

  it('moves on renderer milestones for prefs and auth only', () => {
    expect(stepForMilestone('prefs loaded')).toBe('prefs-loaded')
    expect(stepForMilestone('auth loaded')).toBe('auth-loaded')
    expect(stepForMilestone('bundle started')).toBeNull()
  })
})

describe('when the main window is shown', () => {
  it('is shown after the first screen, unless Kasboek started in the tray for a Claude app', () => {
    expect(shouldShowMainWindow({ background: false, showRequested: false })).toBe(true)
    expect(shouldShowMainWindow({ background: true, showRequested: false })).toBe(false)
  })
  it('a second launch that came early still brings the window up in a background start', () => {
    expect(shouldShowMainWindow({ background: true, showRequested: true })).toBe(true)
    expect(shouldShowMainWindow({ background: false, showRequested: true })).toBe(true)
  })
})

describe('operations before the account is read', () => {
  it('lets only app and preference operations go ahead', () => {
    for (const op of ['app.info', 'app.ready', 'app.milestone', 'prefs.get', 'prefs.update']) expect(opWaitsForSession(op)).toBe(false)
    for (const op of ['auth.status', 'auth.unlock', 'auth.setup', 'transfer.pick', 'sync.pickJoin', 'accounts.list']) expect(opWaitsForSession(op)).toBe(true)
  })
})

describe('milestone lines', () => {
  it('is one fixed line with a rounded time', () => {
    expect(milestoneLine('prefs loaded', 1234.56, 0)).toBe('renderer: prefs loaded at 1235 ms')
  })
  it('stops after the limit', () => {
    expect(milestoneLine('x', 1, MAX_MILESTONES - 1)).not.toBeNull()
    expect(milestoneLine('x', 1, MAX_MILESTONES)).toBeNull()
  })
})

describe('first start of a version', () => {
  it('is the first start when nothing, or another version, was recorded', () => {
    expect(isFirstStartOfVersion(null, '0.21.0')).toBe(true)
    expect(isFirstStartOfVersion('0.20.0', '0.21.0')).toBe(true)
    expect(isFirstStartOfVersion('0.21.0', '0.21.0')).toBe(false)
    expect(isFirstStartOfVersion('0.21.0\n', '0.21.0')).toBe(false)
  })
})

describe('time before the log starts', () => {
  it('is the gap between the program being created and the script starting, and the time since', () => {
    // Created at t=1000; now is t=6000 and the script has been running 2 s: it started at t=4000.
    expect(startGap(1_000, 6_000, 2)).toEqual({ beforeScriptMs: 3_000, sinceCreatedMs: 5_000 })
  })
  it('is unknown without a creation time', () => {
    expect(startGap(undefined, 6_000, 2)).toBeNull()
    expect(startGap(0, 6_000, 2)).toBeNull()
    expect(startGap(Number.NaN, 6_000, 2)).toBeNull()
  })
})

describe('log lines', () => {
  it('shows the time since the process started, in milliseconds', () => {
    expect(formatLogLine(1.2344, 'hello')).toBe('  1234 ms  hello\n')
  })
})

describe('log buffer', () => {
  afterEach(() => vi.useRealTimers())

  it('writes lines in one batch, not one write per line', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const log = new LogBuffer((t) => writes.push(t))
    log.add('a\n')
    log.add('b\n')
    log.add('c\n')
    expect(writes).toEqual([])
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(['a\nb\nc\n'])
    log.add('d\n')
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(['a\nb\nc\n', 'd\n'])
  })

  it('flushes at once when asked (the process is ending), and writes nothing twice', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const log = new LogBuffer((t) => writes.push(t))
    log.add('a\n')
    log.flush()
    expect(writes).toEqual(['a\n'])
    vi.advanceTimersByTime(500)
    log.flush()
    expect(writes).toEqual(['a\n'])
  })

  it('keeps at most the line limit per run', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const log = new LogBuffer((t) => writes.push(t))
    for (let i = 0; i < MAX_LOG_LINES + 50; i++) log.add(`${i}\n`)
    log.flush()
    expect(writes.join('').split('\n').filter(Boolean)).toHaveLength(MAX_LOG_LINES)
    expect(log.count).toBe(MAX_LOG_LINES)
  })

  it('never throws when the file cannot be written', () => {
    vi.useFakeTimers()
    const log = new LogBuffer(() => {
      throw new Error('disk full')
    })
    log.add('a\n')
    expect(() => log.flush()).not.toThrow()
  })
})

describe('log rotation', () => {
  const fakeFs = (files: Record<string, string>, failRename = false) => ({
    files,
    fs: {
      exists: (f: string) => f in files,
      rename: (a: string, b: string) => {
        if (failRename) throw new Error('EPERM')
        files[b] = files[a]!
        delete files[a]
      },
      write: (f: string, t: string) => void (files[f] = t)
    }
  })

  it('keeps the previous log and starts an empty one', () => {
    const { files, fs } = fakeFs({ 'startup.log': 'old run\n' })
    rotateLog(fs, 'startup.log', 'startup.prev.log')
    expect(files).toEqual({ 'startup.prev.log': 'old run\n', 'startup.log': '' })
  })

  it('replaces an older previous log', () => {
    const { files, fs } = fakeFs({ 'startup.log': 'new\n', 'startup.prev.log': 'older\n' })
    rotateLog(fs, 'startup.log', 'startup.prev.log')
    expect(files['startup.prev.log']).toBe('new\n')
  })

  it('works on a first run, with no log yet', () => {
    const { files, fs } = fakeFs({})
    rotateLog(fs, 'startup.log', 'startup.prev.log')
    expect(files).toEqual({ 'startup.log': '' })
  })

  it('still clears the log when the old one cannot be moved', () => {
    const { files, fs } = fakeFs({ 'startup.log': 'old\n' }, true)
    expect(() => rotateLog(fs, 'startup.log', 'startup.prev.log')).not.toThrow()
    expect(files['startup.log']).toBe('')
  })
})
