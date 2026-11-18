import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

describe('licence', () => {
  it('declares GPL-3.0-only in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { license?: string }
    expect(pkg.license).toBe('GPL-3.0-only')
  })

  it('ships the GPL v3 text in LICENSE', () => {
    const file = join(root, 'LICENSE')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines[0]?.trim()).toBe('GNU GENERAL PUBLIC LICENSE')
    expect(lines[1]?.trim()).toBe('Version 3, 29 June 2007')
  })
})
