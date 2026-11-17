import { describe, expect, it } from 'vitest'
import { PAINTED_SCRIPT, progressScript, splashHtml, splashUrl } from '../src/main/splash-page'

describe('launch window page', () => {
  it('is a complete page with no script and no outside file', () => {
    for (const dark of [false, true]) {
      const html = splashHtml(dark)
      expect(html).not.toMatch(/<script/i)
      expect(html).not.toMatch(/(?:src|href)=/i)
      expect(html).toContain('Content-Security-Policy')
      expect(html).toContain('<svg')
      expect(html).toContain('Kasboek')
    }
  })

  it('has the theme in it from the first frame, so there is no light flash in dark mode', () => {
    const dark = splashHtml(true)
    expect(dark).toContain('class="dark"')
    expect(dark).toContain('background:#0e110f')
    expect(dark).toContain('color-scheme: dark')
    const light = splashHtml(false)
    expect(light).toContain('class="light"')
    expect(light).toContain('background:#fafaf8')
  })

  it('loads as a data address that decodes to the same page', () => {
    const url = splashUrl(true)
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(splashHtml(true))
  })
})

describe('progress script', () => {
  it('sets the width, the accessible value and the text', () => {
    const js = progressScript(0.5, 'Opening your data…')
    expect(js).toContain("style.width = '50%'")
    expect(js).toContain("'aria-valuenow', '50'")
    expect(js).toContain('"Opening your data…"')
  })
  it('keeps the bar between its first position and full', () => {
    expect(progressScript(0, 'x')).toContain("style.width = '6%'")
    expect(progressScript(7, 'x')).toContain("style.width = '100%'")
  })
  it('quotes the text so it cannot end the string', () => {
    const js = progressScript(0.2, 'a"); alert(1); ("')
    expect(js).toContain(JSON.stringify('a"); alert(1); ("'))
  })
  it('waits for two frames before it answers', () => {
    expect(PAINTED_SCRIPT.match(/requestAnimationFrame/g)).toHaveLength(2)
  })
})
