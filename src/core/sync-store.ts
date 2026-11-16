/**
 * Where sync files live: a folder that a cloud app keeps in step, or a WebDAV server (Nextcloud,
 * ownCloud, Synology, QNAP, Koofr, pCloud, a NAS, …). Only encrypted files go there either way.
 *
 * The interface is small and asynchronous on purpose, and WebDavStore uses only `fetch`, so a
 * mobile app can sync with the same code (phones can't rely on a synced folder).
 * Paths are relative to the "Kasboek sync" folder, with "/" between parts.
 */
import { AppError } from './errors'

export interface StoreEntry {
  name: string
  dir: boolean
  /** Last change, ms since 1970 (0 when unknown). */
  mtime: number
}

export interface SyncStore {
  /** Shown to the person: a folder path or the server address. */
  readonly label: string
  read(path: string): Promise<Uint8Array | null>
  /** Replaces the file as a whole: readers see the old or the new file, never half of one. */
  write(path: string, data: Uint8Array): Promise<void>
  /** The entries in a folder; empty when it doesn't exist. */
  list(dir: string): Promise<StoreEntry[]>
  /** Creates the folder and its parents; fine when it exists. */
  mkdir(dir: string): Promise<void>
  /** Fine when the file doesn't exist. */
  remove(path: string): Promise<void>
}

export const SYNC_DIR = 'Kasboek sync'

/* ---------- WebDAV ---------- */

export interface WebDavConfig {
  /** The folder on the server to sync through, e.g. https://cloud.example.com/remote.php/dav/files/me/ */
  url: string
  user: string
  password: string
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i

/** The server address, checked: https, or http only inside the home network (a NAS). */
export function normalizeWebDavUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new AppError('webdav.bad_url', 'Enter the full address of the WebDAV folder, starting with https://')
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && PRIVATE_HOST.test(u.hostname))) {
    throw new AppError('webdav.insecure', 'Use an https:// address. Plain http:// is only allowed for a server in your home network.')
  }
  if (u.username || u.password) throw new AppError('webdav.bad_url', 'Enter the user name and password in their own fields, not in the address.')
  u.hash = ''
  u.search = ''
  if (!u.pathname.endsWith('/')) u.pathname += '/'
  return u.toString()
}

const encodePath = (path: string): string => path.split('/').filter(Boolean).map(encodeURIComponent).join('/')

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The parts of a PROPFIND answer Kasboek needs, without an XML library (namespace prefixes vary). */
export function parsePropfind(xml: string): { href: string; dir: boolean; mtime: number }[] {
  const out: { href: string; dir: boolean; mtime: number }[] = []
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1]!
    const href = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(body)?.[1]?.trim()
    if (!href) continue
    const dir = /<(?:[\w-]+:)?collection\b/i.test(body)
    const mod = /<(?:[\w-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getlastmodified>/i.exec(body)?.[1]
    out.push({ href: href.replace(/&amp;/g, '&'), dir, mtime: mod ? Date.parse(mod) || 0 : 0 })
  }
  return out
}

export class WebDavStore implements SyncStore {
  readonly label: string
  private readonly root: string
  private readonly auth: string
  private readonly made = new Set<string>()

  constructor(
    config: WebDavConfig,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly timeoutMs = 60_000
  ) {
    const base = normalizeWebDavUrl(config.url)
    this.label = base
    this.root = new URL(`${encodeURIComponent(SYNC_DIR)}/`, base).toString()
    this.auth = `Basic ${b64(`${config.user}:${config.password}`)}`
  }

  private url(path: string, dir = false): string {
    const p = encodePath(path)
    return this.root + p + (dir && p ? '/' : '')
  }

  private async req(method: string, url: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchFn(url, {
        method,
        headers: { Authorization: this.auth, ...init.headers },
        // A copy: a Node Buffer can be a view into a larger shared block.
        body: init.body ? (Uint8Array.prototype.slice.call(init.body).buffer as ArrayBuffer) : undefined,
        signal: ctrl.signal,
        redirect: 'follow'
      })
      if (res.status === 401 || res.status === 403) throw new AppError('webdav.auth', 'The WebDAV server didn’t accept the user name or password.')
      return res
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError('webdav.unreachable', `Can’t reach the WebDAV server (${err instanceof Error ? err.message : String(err)}).`)
    } finally {
      clearTimeout(timer)
    }
  }

  private static fail(what: string, res: Response): never {
    throw new AppError('webdav.failed', `The WebDAV server refused to ${what} (HTTP ${res.status}).`)
  }

  async read(path: string): Promise<Uint8Array | null> {
    const res = await this.req('GET', this.url(path))
    if (res.status === 404) return null
    if (!res.ok) WebDavStore.fail('send a file', res)
    return new Uint8Array(await res.arrayBuffer())
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    const name = parts.pop()!
    const dir = parts.join('/')
    await this.mkdir(dir)
    // Upload under a temporary name, then rename over the target, so readers never see half a file.
    const tmp = [...parts, `.${name}.${Math.random().toString(36).slice(2, 10)}.partial`].join('/')
    const put = await this.req('PUT', this.url(tmp), { body: data, headers: { 'Content-Type': 'application/octet-stream' } })
    if (!put.ok) WebDavStore.fail('store a file', put)
    const move = await this.req('MOVE', this.url(tmp), { headers: { Destination: this.url(path), Overwrite: 'T' } })
    if (move.ok) return
    // A server without MOVE: write the file directly instead.
    await this.req('DELETE', this.url(tmp)).catch(() => undefined)
    const direct = await this.req('PUT', this.url(path), { body: data, headers: { 'Content-Type': 'application/octet-stream' } })
    if (!direct.ok) WebDavStore.fail('store a file', direct)
  }

  async list(dir: string): Promise<StoreEntry[]> {
    const url = this.url(dir, true)
    const res = await this.req('PROPFIND', url, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>')
    })
    if (res.status === 404) return []
    if (!res.ok) WebDavStore.fail('list a folder', res)
    const self = new URL(url).pathname.replace(/\/+$/, '')
    const out: StoreEntry[] = []
    for (const e of parsePropfind(await res.text())) {
      let p: string
      try {
        p = new URL(e.href, url).pathname.replace(/\/+$/, '')
      } catch {
        continue
      }
      if (p === self || !p.startsWith(self + '/')) continue
      const name = decodeURIComponent(p.slice(self.length + 1))
      if (!name || name.includes('/') || name.endsWith('.partial')) continue
      out.push({ name, dir: e.dir, mtime: e.mtime })
    }
    return out
  }

  async mkdir(dir: string): Promise<void> {
    let path = ''
    for (const part of ['', ...dir.split('/').filter(Boolean)]) {
      path = path ? `${path}/${part}` : part
      const url = path ? this.url(path, true) : this.root
      if (this.made.has(url)) continue
      const res = await this.req('MKCOL', url)
      // 405: it exists already. 301/302 can come back for an existing folder without a final slash.
      if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 302) WebDavStore.fail('create a folder', res)
      this.made.add(url)
    }
  }

  async remove(path: string): Promise<void> {
    const res = await this.req('DELETE', this.url(path))
    if (!res.ok && res.status !== 404) WebDavStore.fail('remove a file', res)
  }
}
