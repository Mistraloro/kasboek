import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebDavStore, normalizeWebDavUrl, parsePropfind } from '@core/sync-store'

/** A small WebDAV server in memory: GET, PUT, MOVE, MKCOL, DELETE, PROPFIND (Depth 1), Basic auth. */
function mockDav(opts: { noMove?: boolean } = {}) {
  const files = new Map<string, Buffer>()
  const dirs = new Set<string>(['/dav/'])
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Basic ${Buffer.from('me:secret').toString('base64')}`) return res.writeHead(401).end()
      const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
      const parent = path.replace(/\/[^/]+\/?$/, '/')
      switch (req.method) {
        case 'GET':
          return files.has(path) ? res.writeHead(200).end(files.get(path)) : res.writeHead(404).end()
        case 'PUT':
          if (!dirs.has(parent)) return res.writeHead(409).end()
          files.set(path, Buffer.concat(chunks))
          return res.writeHead(201).end()
        case 'MOVE': {
          if (opts.noMove) return res.writeHead(501).end()
          const to = decodeURIComponent(new URL(String(req.headers.destination)).pathname)
          if (!files.has(path)) return res.writeHead(404).end()
          files.set(to, files.get(path)!)
          files.delete(path)
          return res.writeHead(201).end()
        }
        case 'MKCOL':
          if (dirs.has(path)) return res.writeHead(405).end()
          if (!dirs.has(parent)) return res.writeHead(409).end()
          dirs.add(path)
          return res.writeHead(201).end()
        case 'DELETE':
          return files.delete(path) ? res.writeHead(204).end() : res.writeHead(404).end()
        case 'PROPFIND': {
          const dir = path.endsWith('/') ? path : path + '/'
          if (!dirs.has(dir)) return res.writeHead(404).end()
          const kids = [...dirs].filter((d) => d !== dir && d.startsWith(dir) && !d.slice(dir.length, -1).includes('/'))
          const fs = [...files.keys()].filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
          const resp = (href: string, col: boolean) =>
            `<d:response><d:href>${encodeURI(href)}</d:href><d:propstat><d:prop><d:resourcetype>${col ? '<d:collection/>' : ''}</d:resourcetype><d:getlastmodified>Mon, 16 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`
          return res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${resp(dir, true)}${kids.map((k) => resp(k, true)).join('')}${fs.map((f) => resp(f, false)).join('')}</d:multistatus>`)
        }
      }
      res.writeHead(405).end()
    })
  })
  return { server, files, dirs }
}

describe('WebDAV store', () => {
  const dav = mockDav()
  const plain = mockDav({ noMove: true })
  let base = ''
  let basePlain = ''
  beforeAll(async () => {
    await new Promise<void>((r) => dav.server.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => plain.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(dav.server.address() as { port: number }).port}/dav`
    basePlain = `http://127.0.0.1:${(plain.server.address() as { port: number }).port}/dav`
  })
  afterAll(() => {
    dav.server.close()
    plain.server.close()
  })

  it('writes, lists, reads and removes files in "Kasboek sync"', async () => {
    const s = new WebDavStore({ url: base, user: 'me', password: 'secret' })
    await s.write('group.json', new TextEncoder().encode('{"format":1}'))
    await s.write('abcdef12/c-0000000001.kbsync', Uint8Array.from([1, 2, 3]))
    expect([...dav.files.keys()].sort()).toEqual(['/dav/Kasboek sync/abcdef12/c-0000000001.kbsync', '/dav/Kasboek sync/group.json'])
    expect((await s.list('')).map((e) => [e.name, e.dir]).sort()).toEqual([['abcdef12', true], ['group.json', false]])
    expect((await s.list('abcdef12'))[0]!.mtime).toBe(Date.parse('Mon, 16 Nov 2026 10:00:00 GMT'))
    expect([...(await s.read('abcdef12/c-0000000001.kbsync'))!]).toEqual([1, 2, 3])
    expect(await s.read('nope.json')).toBeNull()
    expect(await s.list('missing')).toEqual([])
    await s.remove('abcdef12/c-0000000001.kbsync')
    await s.remove('abcdef12/c-0000000001.kbsync')
    expect(await s.list('abcdef12')).toEqual([])
  })

  it('works with a server without MOVE, and says when the login is wrong', async () => {
    const s = new WebDavStore({ url: basePlain, user: 'me', password: 'secret' })
    await s.write('group.json', Uint8Array.from([7]))
    expect([...plain.files.keys()]).toEqual(['/dav/Kasboek sync/group.json'])
    const bad = new WebDavStore({ url: base, user: 'me', password: 'wrong' })
    await expect(bad.read('group.json')).rejects.toMatchObject({ code: 'webdav.auth' })
  })

  it('accepts https, or http only in the home network', () => {
    expect(normalizeWebDavUrl('https://cloud.example.com/remote.php/dav/files/me')).toBe('https://cloud.example.com/remote.php/dav/files/me/')
    expect(normalizeWebDavUrl('http://192.168.1.20:5005/home')).toBe('http://192.168.1.20:5005/home/')
    expect(() => normalizeWebDavUrl('http://cloud.example.com/dav')).toThrow()
    expect(() => normalizeWebDavUrl('https://me:pw@cloud.example.com/')).toThrow()
    expect(() => normalizeWebDavUrl('cloud')).toThrow()
  })

  it('reads PROPFIND answers with any namespace prefix', () => {
    const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/b%20c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response><response xmlns="DAV:"><href>/a/x.json</href><propstat><prop><resourcetype/><getlastmodified>Mon, 16 Nov 2026 10:00:00 GMT</getlastmodified></prop></propstat></response></D:multistatus>'
    expect(parsePropfind(xml)).toEqual([
      { href: '/a/b%20c/', dir: true, mtime: 0 },
      { href: '/a/x.json', dir: false, mtime: Date.parse('Mon, 16 Nov 2026 10:00:00 GMT') }
    ])
  })
})
