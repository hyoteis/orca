import { describe, expect, it } from 'vitest'
import { definitionTargets } from './cpp-definition-locations'

describe('definitionTargets', () => {
  it('normalizes Location and LocationLink results', () => {
    const range = {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 9 }
    }
    expect(definitionTargets({ uri: 'file:///repo/a.hpp', range })).toEqual([
      { uri: 'file:///repo/a.hpp', range }
    ])
    expect(
      definitionTargets([
        {
          targetUri: 'file:///repo/b.hpp',
          targetRange: range,
          targetSelectionRange: range
        }
      ])
    ).toEqual([{ uri: 'file:///repo/b.hpp', range }])
  })
})
