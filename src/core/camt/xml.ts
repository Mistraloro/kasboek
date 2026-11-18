/**
 * A small XML reader for bank statements. It builds a tree of elements and nothing else: no DTD, no
 * entities other than the five built-in ones and character references, no namespace lookups (names are
 * kept without their prefix), no external resources, no code. Because entities cannot be defined, an
 * "XML bomb" or an external-entity file (XXE) has nothing to work with: a DOCTYPE is refused outright.
 * It does not iterate recursively, so deeply nested input cannot overflow the stack.
 */

export interface XmlNode {
  /** Element name without namespace prefix. */
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** The element's own text (trimmed). */
  text: string
}

export type XmlFailure = 'dtd' | 'broken' | 'too_large'

export class XmlError extends Error {
  constructor(public readonly failure: XmlFailure, message: string) {
    super(message)
    this.name = 'XmlError'
  }
}

/** Nesting deeper than this is not a statement. */
const MAX_DEPTH = 64
/** More elements than this (about a 20 MB file) is refused before memory runs out. */
const MAX_ELEMENTS = 2_000_000

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (_m, ref: string) => {
    if (ref[0] !== '#') {
      const named = Object.hasOwn(NAMED, ref) ? NAMED[ref] : undefined
      if (named === undefined) throw new XmlError('broken', `Unknown entity &${ref};`)
      return named
    }
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1))
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError('broken', 'Bad character reference')
    return String.fromCodePoint(code)
  })
}

const NAME = /[^\s/>=<"']+/y
const SPACE = /\s*/y

function fail(message: string): never {
  throw new XmlError('broken', message)
}

export function parseXml(source: string): XmlNode {
  let src = source
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
  const stack: XmlNode[] = []
  const texts: string[][] = []
  let root: XmlNode | null = null
  let count = 0
  let pos = 0

  while (pos < src.length) {
    const lt = src.indexOf('<', pos)
    const chunk = src.slice(pos, lt < 0 ? src.length : lt)
    if (chunk) {
      const top = texts.at(-1)
      if (top) top.push(decode(chunk))
      else if (chunk.trim()) fail('Text outside the root element')
    }
    if (lt < 0) break
    pos = lt
    if (src.startsWith('<!--', pos)) {
      const end = src.indexOf('-->', pos + 4)
      if (end < 0) fail('Unclosed comment')
      pos = end + 3
    } else if (src.startsWith('<![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos + 9)
      if (end < 0 || !texts.length) fail('Bad CDATA section')
      texts.at(-1)!.push(src.slice(pos + 9, end))
      pos = end + 3
    } else if (src.startsWith('<?', pos)) {
      const end = src.indexOf('?>', pos + 2)
      if (end < 0) fail('Unclosed processing instruction')
      pos = end + 2
    } else if (src.startsWith('<!', pos)) {
      // <!DOCTYPE …> and <!ENTITY …>: where XML bombs and external entities come from.
      throw new XmlError('dtd', 'A DTD is not allowed')
    } else if (src.startsWith('</', pos)) {
      NAME.lastIndex = pos + 2
      const m = NAME.exec(src)
      const end = src.indexOf('>', pos)
      const top = stack.at(-1)
      if (!m || end < 0 || !top || m[0].replace(/^.*:/, '') !== top.name || src.slice(NAME.lastIndex, end).trim()) fail('Mismatched closing tag')
      const parts = texts.pop()!
      top.text = parts.join('').trim()
      stack.pop()
      pos = end + 1
    } else {
      NAME.lastIndex = pos + 1
      const m = NAME.exec(src)
      if (!m) fail('Bad tag')
      const node: XmlNode = { name: m[0].replace(/^.*:/, ''), attrs: {}, children: [], text: '' }
      pos = NAME.lastIndex
      let selfClosing = false
      for (;;) {
        SPACE.lastIndex = pos
        SPACE.exec(src)
        pos = SPACE.lastIndex
        const c = src[pos]
        if (c === '>') {
          pos++
          break
        }
        if (c === '/' && src[pos + 1] === '>') {
          selfClosing = true
          pos += 2
          break
        }
        NAME.lastIndex = pos
        const attr = NAME.exec(src)
        if (!attr) fail('Bad attribute')
        pos = NAME.lastIndex
        SPACE.lastIndex = pos
        SPACE.exec(src)
        pos = SPACE.lastIndex
        if (src[pos] !== '=') fail('Attribute without value')
        SPACE.lastIndex = pos + 1
        SPACE.exec(src)
        pos = SPACE.lastIndex
        const quote = src[pos]
        if (quote !== '"' && quote !== "'") fail('Attribute value without quotes')
        const close = src.indexOf(quote, pos + 1)
        if (close < 0) fail('Unclosed attribute value')
        const value = src.slice(pos + 1, close)
        if (value.includes('<')) fail('Bad attribute value')
        node.attrs[attr[0]] = decode(value)
        pos = close + 1
      }
      if (++count > MAX_ELEMENTS) throw new XmlError('too_large', 'Too many elements')
      const parent = stack.at(-1)
      if (parent) parent.children.push(node)
      else if (root) fail('More than one root element')
      else root = node
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError('too_large', 'Nested too deeply')
        stack.push(node)
        texts.push([])
      }
    }
  }
  if (stack.length || !root) fail('The file ends early or has no content')
  return root
}
