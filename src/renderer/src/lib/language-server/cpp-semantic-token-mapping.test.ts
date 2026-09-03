import { describe, expect, it } from 'vitest'
import {
  CPP_SEMANTIC_TOKEN_MODIFIERS,
  CPP_SEMANTIC_TOKEN_TYPES,
  remapCppSemanticTokenData
} from './cpp-semantic-token-mapping'

describe('C++ semantic token mapping', () => {
  it('maps clangd token types and modifiers into Monaco legend indexes', () => {
    const mapped = remapCppSemanticTokenData(
      [0, 4, 6, 0, 0b011, 0, 8, 3, 1, 0b100, 1, 2, 5, 2, 0],
      {
        tokenTypes: ['class', 'function', 'clangdExtension'],
        tokenModifiers: ['readonly', 'static', 'clangdExtension']
      }
    )

    expect([...mapped]).toEqual([
      0,
      4,
      6,
      CPP_SEMANTIC_TOKEN_TYPES.indexOf('class'),
      (2 ** CPP_SEMANTIC_TOKEN_MODIFIERS.indexOf('readonly')) |
        (2 ** CPP_SEMANTIC_TOKEN_MODIFIERS.indexOf('static')),
      0,
      8,
      3,
      CPP_SEMANTIC_TOKEN_TYPES.indexOf('function'),
      0,
      1,
      2,
      5,
      CPP_SEMANTIC_TOKEN_TYPES.indexOf('unknown'),
      0
    ])
  })
})
