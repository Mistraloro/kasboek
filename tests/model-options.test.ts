import { describe, expect, it } from 'vitest'
import { fieldText, filterModels, initialHighlight, modelCounts, modelOptions, modelRows, moveHighlight } from '@shared/model-options'

describe('modelOptions', () => {
  it('lists every loaded model whatever the current value is', () => {
    const loaded = ['a-small', 'b-large', 'c-mini']
    expect(modelOptions(loaded, [], 'a-small')).toEqual(loaded)
    expect(modelOptions(loaded, [], 'c-mini')).toEqual(loaded)
    expect(modelOptions(loaded, [], '')).toEqual(loaded)
  })

  it('merges suggested models without duplicates', () => {
    expect(modelOptions(['x', 'y'], ['y', 'z'], 'x')).toEqual(['x', 'y', 'z'])
  })

  it('keeps a current value the provider does not list', () => {
    expect(modelOptions(['x'], ['z'], 'custom-model')).toEqual(['custom-model', 'x', 'z'])
  })

  it('ignores blank entries and surrounding spaces', () => {
    expect(modelOptions([' x ', ''], [], '  ')).toEqual(['x'])
  })
})

describe('filterModels', () => {
  const options = ['alpha-1', 'beta-2', 'alpha-3']
  it('returns everything for an empty search', () => {
    expect(filterModels(options, '  ')).toEqual(options)
  })
  it('matches case-insensitively and does not keep models that do not match', () => {
    expect(filterModels(options, 'ALPHA')).toEqual(['alpha-1', 'alpha-3'])
    expect(filterModels(options, 'zzz')).toEqual([])
  })
})

describe('modelRows', () => {
  const options = ['alpha-1', 'beta-2', 'alpha-3']
  it('lists every model, after the empty row when there is one', () => {
    expect(modelRows(options, '', false).map((r) => r.kind)).toEqual(['model', 'model', 'model'])
    expect(modelRows(options, '', true)[0]).toEqual({ kind: 'empty' })
    expect(modelRows(options, '', true)).toHaveLength(4)
  })
  it('filters, drops the empty row and offers the typed name when it is not a model', () => {
    expect(modelRows(options, 'alp', true)).toEqual([
      { kind: 'model', model: 'alpha-1' },
      { kind: 'model', model: 'alpha-3' },
      { kind: 'custom', model: 'alp' }
    ])
    expect(modelRows(options, ' nope ', false)).toEqual([{ kind: 'custom', model: 'nope' }])
  })
  it('does not offer the typed name when it is exactly a listed model', () => {
    expect(modelRows(options, 'beta-2', false)).toEqual([{ kind: 'model', model: 'beta-2' }])
  })
})

describe('modelCounts', () => {
  const options = ['alpha-1', 'beta-2', 'alpha-3']
  it('is null without a filter and counts matches against the whole list with one', () => {
    expect(modelCounts(options, '  ')).toBeNull()
    expect(modelCounts(options, 'alpha')).toEqual({ shown: 2, total: 3 })
    expect(modelCounts(options, 'zzz')).toEqual({ shown: 0, total: 3 })
  })
})

describe('fieldText', () => {
  it('shows the selected model unless the person is filtering', () => {
    expect(fieldText('alpha-1', 'be', false)).toBe('alpha-1')
    expect(fieldText('alpha-1', 'be', true)).toBe('be')
    expect(fieldText('alpha-1', '', true)).toBe('')
  })
})

describe('moveHighlight', () => {
  it('moves and wraps around the ends', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1)
    expect(moveHighlight(2, 1, 3)).toBe(0)
    expect(moveHighlight(0, -1, 3)).toBe(2)
  })
  it('starts at the first or last row when nothing is highlighted, and handles no rows', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0)
    expect(moveHighlight(-1, -1, 3)).toBe(2)
    expect(moveHighlight(0, 1, 0)).toBe(-1)
  })
})

describe('initialHighlight', () => {
  const rows = modelRows(['a', 'b', 'c'], '', true)
  it('starts on the current model, the empty row or the first row', () => {
    expect(initialHighlight(rows, 'c')).toBe(3)
    expect(initialHighlight(rows, '')).toBe(0)
    expect(initialHighlight(rows, 'unlisted')).toBe(0)
    expect(initialHighlight([], '')).toBe(-1)
  })
})
