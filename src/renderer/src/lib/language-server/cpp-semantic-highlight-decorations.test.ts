import { describe, expect, it, vi } from 'vitest'
import { CPP_SEMANTIC_TOKEN_TYPES } from './cpp-semantic-token-mapping'

vi.mock('./cpp-definition-navigation', () => ({ getCppSemanticTokens: vi.fn() }))

import { decodeCppSemanticTokenDecorations } from './cpp-semantic-highlight-decorations'

describe('C++ semantic highlight decorations', () => {
  it('decodes relative semantic token positions into color classes', () => {
    const classType = CPP_SEMANTIC_TOKEN_TYPES.indexOf('class')
    const functionType = CPP_SEMANTIC_TOKEN_TYPES.indexOf('function')

    expect(
      decodeCppSemanticTokenDecorations(
        Uint32Array.from([0, 2, 4, classType, 0, 0, 6, 3, functionType, 0])
      )
    ).toEqual([
      {
        lineNumber: 1,
        startColumn: 3,
        endColumn: 7,
        className: 'orca-semantic-type'
      },
      {
        lineNumber: 1,
        startColumn: 9,
        endColumn: 12,
        className: 'orca-semantic-function'
      }
    ])
  })
})
