/**
 * Updates from the project's GitHub releases. Kasboek asks GitHub for the latest release (at start
 * and once a day, when the person allows it), downloads the file for this computer, checks it
 * against the SHA-256 that GitHub reports for it, makes a backup and installs it:
 * - Windows: a helper installs the MSI after Kasboek closes (it shows its own progress window), then Kasboek opens again;
 * - Linux AppImage: the file is replaced and started again;
 * - Linux .deb and macOS .dmg: the file is opened, and the person finishes the install.
 * Only release files of this repository are downloaded; nothing about the person's data is sent.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, nativeTheme, net, shell } from 'electron'
import { AppError } from '@core/errors'
import type { UpdateStatus } from '@shared/types'
import { buildUpdatePlan, checksumFromSums, failedUpdateMessage, installKind, newer, pickAsset, safeAssetName } from '@core/update'
import { helperPath } from './mcp/channel'
import { paths } from './paths'
import { getPrefs } from './prefs'
import { broadcast, isUnlocked } from './session'
import { stamp, writeTransfer } from './transfer/service'
import { updateTexts } from './update-texts'
import { TRANSFER_EXTENSION } from '@core/transfer-format'

const REPO = 'Mistraloro/kasboek'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES = `https://github.com/${REPO}/releases/latest`
const DAY = 24 * 60 * 60 * 1000

/** Development runs only: a stand-in for the GitHub API (tests). Packaged builds always use GitHub. */
const override = (): string | null => (app.isPackaged ? null : process.env['KASBOEK_UPDATE_API'] || null)
const supported = (): boolean => app.isPackaged || !!override()
const updatesDir = (): string => join(paths.dataDir, 'updates')
const pendingFile = (): string => join(updatesDir(), 'pending.json')

interface Asset {
  name: string
  url: string
  size: number
  sha256: string | null
}

let status: UpdateStatus = { state: 'idle', current: app.getVersion(), latest: null, notes: null, pageUrl: null, kind: null, sizeBytes: null, progress: 0, error: null, lastCheckedAt: null, supported: supported() }
let asset: Asset | null = null
let file: string | null = null
let busy = false
/** Kept after a restart where the update didn't install, until it installs. */
let failedInstall: string | null = null
let lastSent = 0

function set(patch: Partial<UpdateStatus>, now = true): UpdateStatus {
  status = { ...status, ...patch }
  // Progress is sent at most a few times a second.
  if (now || Date.now() - lastSent > 250) {
    lastSent = Date.now()
    broadcast({ type: 'update.changed', status })
  }
  return status
}

export function updateStatus(): UpdateStatus {
  return status
}

const allowedDownload = (url: string): boolean => {
  const o = override()
  return o ? url.startsWith(new URL(o).origin + '/') : url.startsWith(`https://github.com/${REPO}/releases/download/`)
}

async function getJson(url: string): Promise<unknown> {
  const res = await net.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kasboek' }, cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new AppError('update.http', `GitHub answered ${res.status}.`)
  return res.json()
}

/** The checksum from GitHub's own record of the file, else from a SHA256SUMS.txt in the release. */
async function checksum(assets: { name: string; browser_download_url: string; digest?: string | null }[], name: string): Promise<string | null> {
  const own = assets.find((x) => x.name === name)?.digest
  if (own?.startsWith('sha256:')) return own.slice(7).toLowerCase()
  const sums = assets.find((x) => /^SHA256SUMS(\.txt)?$/i.test(x.name))
  if (!sums || !allowedDownload(sums.browser_download_url)) return null
  const res = await net.fetch(sums.browser_download_url)
  if (!res.ok) return null
  return checksumFromSums(await res.text(), name)
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!supported()) return set({ state: 'idle', supported: false })
  if (busy || status.state === 'downloading' || status.state === 'installing') return status
  busy = true
  set({ state: 'checking', error: failedInstall })
  try {
    const r = (await getJson(override() ?? LATEST)) as {
      tag_name?: string
      body?: string
      html_url?: string
      draft?: boolean
      prerelease?: boolean
      assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[]
    } | null
    const lastCheckedAt = new Date().toISOString()
    if (!r || !r.tag_name || r.draft || r.prerelease || !newer(r.tag_name, app.getVersion())) {
      asset = null
      return set({ state: 'none', error: null, latest: r?.tag_name?.replace(/^v/, '') ?? null, lastCheckedAt })
    }
    const kind = installKind()
    const found = kind ? pickAsset(r.assets ?? [], kind) : null
    // A file name ends up on disk and in the Windows update plan: refuse anything but plain names.
    asset = found && safeAssetName(found.name) && allowedDownload(found.browser_download_url) ? { name: found.name, url: found.browser_download_url, size: found.size, sha256: await checksum(r.assets ?? [], found.name) } : null
    // Downloaded before (e.g. "Later" after the download): ready again.
    const have = asset && existsSync(join(updatesDir(), asset.name)) && status.state === 'ready' && file
    return set({ state: have ? 'ready' : 'available', error: failedInstall, latest: r.tag_name.replace(/^v/, ''), notes: r.body ?? null, pageUrl: r.html_url ?? null, kind: asset ? kind : null, sizeBytes: asset?.size ?? null, progress: have ? 1 : 0, lastCheckedAt })
  } catch (err) {
    return set({ state: 'error', error: err instanceof AppError ? err.message : 'Could not reach GitHub to look for updates.', lastCheckedAt: new Date().toISOString() })
  } finally {
    busy = false
  }
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!asset) throw new AppError('update.none', 'There is no update file for this computer in the latest release.')
  if (!asset.sha256) throw new AppError('update.no_checksum', 'The release has no checksum for this file, so Kasboek won’t install it. Download it from the release page instead.')
  if (status.state === 'downloading') return status
  const target = asset
  mkdirSync(updatesDir(), { recursive: true })
  const dest = join(updatesDir(), basename(target.name))
  const partial = dest + '.partial'
  set({ state: 'downloading', progress: 0, error: null })
  try {
    const res = await net.fetch(target.url, { cache: 'no-store' })
    if (!res.ok || !res.body) throw new AppError('update.http', `The download failed (${res.status}).`)
    const total = Number(res.headers.get('content-length')) || target.size || 0
    const hash = createHash('sha256')
    const out = createWriteStream(partial)
    let got = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      got += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total) set({ progress: Math.min(1, got / total) }, false)
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
    if (hash.digest('hex') !== target.sha256) {
      rmSync(partial, { force: true })
      throw new AppError('update.checksum', 'The downloaded file doesn’t match its checksum, so it was deleted. Try again later.')
    }
    renameSync(partial, dest)
    file = dest
    return set({ state: 'ready', progress: 1 })
  } catch (err) {
    rmSync(partial, { force: true })
    return set({ state: 'error', error: err instanceof AppError ? err.message : 'The download stopped. Check the connection and try again.' })
  }
}

/**
 * Windows: starts a copy of the kasboek-mcp helper that waits for Kasboek to close, installs the MSI
 * and opens Kasboek again, showing a progress window in the meantime. It runs from a copy because the MSI replaces the original in resources.
 * No console is wanted, and `detached` on Windows gives the helper none (so windowsHide isn't set).
 */
async function startUpdateHelper(msi: string, sha256: string): Promise<void> {
  const source = helperPath()
  if (!existsSync(source)) throw new AppError('update.helper_missing', `The update helper is missing from this installation. Download the new version from ${RELEASES} and install it yourself.`)
  const copy = join(updatesDir(), 'kasboek-update.exe')
  const planFile = join(updatesDir(), 'apply.json')
  const dark = getPrefs().theme === 'dark' || (getPrefs().theme === 'system' && nativeTheme.shouldUseDarkColors)
  copyFileSync(source, copy)
  const plan = buildUpdatePlan({
    pid: process.pid,
    exe: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
    msi,
    sha256,
    log: join(updatesDir(), 'install.log'),
    result: join(updatesDir(), 'result.json'),
    updatesDir: updatesDir(),
    toVersion: status.latest ?? '',
    theme: dark ? 'dark' : 'light',
    texts: updateTexts(getPrefs().language)
  })
  rmSync(plan.result, { force: true })
  writeFileSync(planFile, JSON.stringify(plan))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(copy, ['--apply-update', planFile], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Replaces the running AppImage with the new one and starts it. */
function installAppImage(downloaded: string): void {
  const current = process.env['APPIMAGE']!
  const next = join(dirname(current), `.${basename(current)}.new`)
  try {
    copyFileSync(downloaded, next)
    chmodSync(next, 0o755)
    renameSync(next, current)
  } catch {
    rmSync(next, { force: true })
    throw new AppError('update.not_writable', `Kasboek can’t replace ${current}. Download the new AppImage from the release page and replace it yourself.`)
  }
  spawn(current, [], { detached: true, stdio: 'ignore' }).unref()
}

export async function installUpdate(): Promise<UpdateStatus> {
  if (status.state !== 'ready' || !file || !existsSync(file) || !status.kind) throw new AppError('update.not_ready', 'Download the update first.')
  // A copy of the data as it is now, in case the new version needs to be undone.
  if (isUnlocked()) {
    mkdirSync(paths.safetyDir, { recursive: true })
    await writeTransfer(join(paths.safetyDir, `before-update-${stamp()}.${TRANSFER_EXTENSION}`), 'backup')
  }
  if (status.kind === 'dmg' || status.kind === 'deb') {
    const err = await shell.openPath(file)
    if (err) throw new AppError('update.open', `The update was downloaded but couldn’t be opened: ${err}`)
    return set({ state: 'opened' })
  }
  if (status.kind === 'msi' && !asset?.sha256) throw new AppError('update.no_checksum', 'The release has no checksum for this file, so Kasboek won’t install it. Download it from the release page instead.')
  // The note lets the next start tell whether the update went in.
  writeFileSync(pendingFile(), JSON.stringify({ version: status.latest, at: new Date().toISOString() }))
  try {
    if (status.kind === 'msi') await startUpdateHelper(file, asset!.sha256!)
    else installAppImage(file)
  } catch (err) {
    rmSync(pendingFile(), { force: true })
    set({ error: err instanceof AppError ? err.message : 'The update couldn’t be started.' })
    throw err
  }
  set({ state: 'installing' })
  // Closing locks Kasboek (and makes the usual backup on quit).
  setTimeout(() => app.quit(), 300)
  return status
}

export function openReleasePage(): void {
  const url = status.pageUrl ?? RELEASES
  if (url.startsWith('https://github.com/')) void shell.openExternal(url)
}

/** After an update: clean up, or tell the person it didn't install. */
function afterRestart(): void {
  if (!existsSync(pendingFile())) return
  try {
    const { version } = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { version: string }
    let result: unknown = null
    try {
      result = JSON.parse(readFileSync(join(updatesDir(), 'result.json'), 'utf8'))
    } catch {
      // No result: the helper never got as far as writing one.
    }
    const message = failedUpdateMessage(version, app.getVersion(), result)
    if (message) {
      failedInstall = message
      set({ state: 'error', latest: version, error: failedInstall })
      rmSync(pendingFile(), { force: true })
      return
    }
  } catch {
    // An unreadable note: just clean up.
  }
  try {
    rmSync(updatesDir(), { recursive: true, force: true })
  } catch {
    // The helper may still hold its program for a moment: the next start cleans up.
  }
}

let started = false
export function startUpdateChecks(): void {
  if (started) return
  started = true
  try {
    afterRestart()
    // Leftovers from a download that never finished.
    if (existsSync(updatesDir())) for (const f of readdirSync(updatesDir())) if (f.endsWith('.partial')) rmSync(join(updatesDir(), f), { force: true })
  } catch {
    // Never let cleaning up stop Kasboek from starting.
  }
  if (!supported()) return
  // Only once the person has made the choice in the welcome window.
  const due = (): boolean => getPrefs().welcomeDone && getPrefs().updateCheck && (!status.lastCheckedAt || Date.now() - Date.parse(status.lastCheckedAt) > DAY)
  setTimeout(() => void (due() && checkForUpdate()), 15_000)
  setInterval(() => void (due() && checkForUpdate()), 60 * 60 * 1000)
}
