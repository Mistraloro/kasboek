import { describe, expect, it } from 'vitest'
import { filterModels, modelOptions } from '@shared/model-options'

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
    expect(filterModels(options, '  ', 'beta-2')).toEqual(options)
  })
  it('matches case-insensitively and keeps the current value', () => {
    expect(filterModels(options, 'ALPHA', 'beta-2')).toEqual(['alpha-1', 'beta-2', 'alpha-3'])
    expect(filterModels(options, 'alpha-3', 'alpha-1')).toEqual(['alpha-1', 'alpha-3'])
  })
})
