/**
 * Start-up decisions that need no Electron, so they can be tested: the launch window's progress, when
 * the main window may be shown, the start-up log (rotation, line cap, buffering) and its timing facts.
 */

/* ---------- Progress of the launch window ---------- */

/** The real steps of a start, in order. `at` is the bar position (0 to 1) when the step is reached. */
export const PROGRESS_STEPS = [
  { id: 'begin', at: 0.06, text: 'Starting…' },
  { id: 'launch-window-loaded', at: 0.12, text: 'Starting…' },
  { id: 'app-code-loaded', at: 0.25, text: 'Opening your data…' },
  { id: 'data-opened', at: 0.4, text: 'Preparing…' },
  { id: 'main-window-created', at: 0.5, text: 'Loading the interface…' },
  { id: 'interface-script-run', at: 0.65, text: 'Loading the interface…' },
  { id: 'prefs-loaded', at: 0.78, text: 'Loading the interface…' },
  { id: 'auth-loaded', at: 0.88, text: 'Almost ready…' },
  { id: 'first-screen', at: 0.95, text: 'Almost ready…' }
] as const

export type ProgressStep = (typeof PROGRESS_STEPS)[number]['id']

/** Between two steps the bar creeps toward the next one, but never reaches it: only the real event does. */
const CREEP_SHARE = 0.85
/** About two thirds of the creep is made after this long, so a long phase keeps moving for many seconds. */
const CREEP_MS = 5_000

/** Where the bar is (0 to 1) when `step` was reached `msSinceStep` ago and the next step has not happened yet. */
export function progressAt(step: ProgressStep, msSinceStep: number): number {
  const i = PROGRESS_STEPS.findIndex((s) => s.id === step)
  const from = PROGRESS_STEPS[i]!.at
  const to = PROGRESS_STEPS[i + 1]?.at ?? 1
  const t = Math.max(0, msSinceStep)
  return from + (to - from) * CREEP_SHARE * (1 - Math.exp(-t / CREEP_MS))
}

export function stepText(step: ProgressStep): string {
  return PROGRESS_STEPS.find((s) => s.id === step)!.text
}

/** The progress step a renderer milestone stands for, if any. */
export function stepForMilestone(name: string): ProgressStep | null {
  if (name === 'prefs loaded') return 'prefs-loaded'
  if (name === 'auth loaded') return 'auth-loaded'
  return null
}

/** A step that is earlier than one already reached is ignored (events can arrive in any order). */
export function laterStep(current: ProgressStep, next: ProgressStep): ProgressStep {
  const rank = (s: ProgressStep): number => PROGRESS_STEPS.findIndex((x) => x.id === s)
  return rank(next) > rank(current) ? next : current
}

/* ---------- When the main window may be shown ---------- */

/** The main window must be shown at the latest this long after it was created, even without a first-screen signal. */
export const MAIN_WINDOW_SAFETY_MS = 8_000
/** The app code starts loading when the launch window has painted, or after this long, whichever comes first. */
export const SPLASH_HEAD_START_MS = 300

/** Shown after the first screen (or the safety timeout), unless Kasboek runs in the tray for a Claude app and nobody asked for it. */
export function shouldShowMainWindow(o: { background: boolean; showRequested: boolean }): boolean {
  return !o.background || o.showRequested
}

/**
 * The account is read while the main window is created, so an operation that looks at it waits for
 * that. Only the app and preference operations (theme, language, graphics, timing facts) go ahead.
 */
export function opWaitsForSession(op: string): boolean {
  return !op.startsWith('app.') && !op.startsWith('prefs.')
}

/* ---------- Renderer milestones ---------- */

export const MAX_MILESTONES = 20

/** One `renderer: …` line in the log, or null once the run has used up its lines. */
export function milestoneLine(name: string, ms: number, alreadyLogged: number): string | null {
  if (alreadyLogged >= MAX_MILESTONES) return null
  return `renderer: ${name} at ${Math.round(ms)} ms`
}

/* ---------- Timing facts ---------- */

/** First start of this version: nothing was recorded before, or another version was. */
export function isFirstStartOfVersion(previous: string | null, current: string): boolean {
  return previous === null || previous.trim() !== current
}

/**
 * How long the program ran before our script started, and how long since it was created. `created` is
 * when the operating system created the browser process (epoch ms); `uptimeSeconds` is process.uptime()
 * now. Returns null when the creation time is not known.
 */
export function startGap(created: number | undefined, nowMs: number, uptimeSeconds: number): { beforeScriptMs: number; sinceCreatedMs: number } | null {
  if (!created || !Number.isFinite(created) || created <= 0) return null
  const scriptStarted = nowMs - uptimeSeconds * 1000
  return { beforeScriptMs: Math.round(scriptStarted - created), sinceCreatedMs: Math.round(nowMs - created) }
}

/* ---------- The log ---------- */

export const MAX_LOG_LINES = 200

/** One line, with the time since the process started. */
export function formatLogLine(uptimeSeconds: number, text: string): string {
  return `${(uptimeSeconds * 1000).toFixed(0).padStart(6)} ms  ${text}\n`
}

/**
 * Collects lines and writes them in batches, so the file is not opened for every line. At most
 * `maxLines` lines per run; the rest are dropped. `append` writes to the file and may throw (ignored).
 */
export class LogBuffer {
  private pending = ''
  private lines = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly append: (text: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly maxLines = MAX_LOG_LINES,
    private readonly delayMs = 150
  ) {}

  add(line: string): void {
    if (this.lines >= this.maxLines) return
    this.lines++
    this.pending += line
    if (!this.timer) {
      this.timer = this.schedule(() => this.flush(), this.delayMs)
      this.timer.unref?.()
    }
  }

  /** Writes what is waiting now (also used right before the process ends). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    const text = this.pending
    this.pending = ''
    try {
      this.append(text)
    } catch {
      // The log is a convenience; never let it stop the app.
    }
  }

  get count(): number {
    return this.lines
  }
}

export interface LogFiles {
  exists(file: string): boolean
  rename(from: string, to: string): void
  write(file: string, text: string): void
}

/** The log of the previous run is kept as `prev`; the new run starts with an empty log. Never throws. */
export function rotateLog(fs: LogFiles, file: string, prev: string): void {
  try {
    if (fs.exists(file)) fs.rename(file, prev)
  } catch {
    // The old log could not be moved (a locked file): it is cleared below instead.
  }
  try {
    fs.write(file, '')
  } catch {
    // The log is a convenience.
  }
}
