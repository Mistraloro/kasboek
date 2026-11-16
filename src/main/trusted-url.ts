/** Which page addresses may call operations or be navigated to. Kept free of Electron so it can be tested. */
import { pathToFileURL } from 'node:url'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** The dev server (electron-vite) is only honoured in an unpackaged run; a page counts when its origin is the server's. */
export function isDevRendererUrl(url: string, devUrl: string | undefined, packaged: boolean): boolean {
  if (packaged || !devUrl) return false
  const dev = parse(devUrl)
  const page = parse(url)
  return !!dev && !!page && (dev.protocol === 'http:' || dev.protocol === 'https:') && page.origin === dev.origin
}

/** A page of the built app: a file inside the renderer directory (the folder itself with a trailing slash, never a sibling that merely starts with the same text). */
export function isTrustedFrameUrl(url: string, rendererDir: string, devUrl: string | undefined, packaged: boolean): boolean {
  if (isDevRendererUrl(url, devUrl, packaged)) return true
  const page = parse(url)
  if (!page || !rendererDir || page.protocol !== 'file:') return false
  const base = pathToFileURL(rendererDir)
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  return page.origin === base.origin && page.host === base.host && page.pathname.startsWith(prefix)
}
