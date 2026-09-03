import type { SemanticTokensLegend } from 'vscode-languageserver-protocol'

export const CPP_SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'label',
  'comment',
  'string',
  'keyword',
  'number',
  'regexp',
  'operator',
  'decorator',
  'dependentType',
  'concept',
  // Sentinel for server-private clangd types (unknown, bracket, …): no class, syntax highlighting
  // keeps the color. Doubles as a client-capability legend slot (InitializeParams tokenTypes).
  'unknown'
] as const

export const CPP_SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
  'deduced',
  'virtual'
] as const

const UNMAPPED_TOKEN_TYPE = CPP_SEMANTIC_TOKEN_TYPES.indexOf('unknown')

export function remapCppSemanticTokenData(
  data: readonly number[],
  serverLegend: SemanticTokensLegend
): Uint32Array {
  const tokenTypeIndexes = serverLegend.tokenTypes.map((type) => {
    const index = CPP_SEMANTIC_TOKEN_TYPES.indexOf(
      type as (typeof CPP_SEMANTIC_TOKEN_TYPES)[number]
    )
    return index === -1 ? UNMAPPED_TOKEN_TYPE : index
  })
  const modifierIndexes = serverLegend.tokenModifiers.map((modifier) =>
    CPP_SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier as (typeof CPP_SEMANTIC_TOKEN_MODIFIERS)[number])
  )
  const result = Uint32Array.from(data)
  for (let index = 0; index + 4 < result.length; index += 5) {
    result[index + 3] = tokenTypeIndexes[result[index + 3]] ?? UNMAPPED_TOKEN_TYPE
    const serverModifiers = result[index + 4]
    let clientModifiers = 0
    for (let bit = 0; bit < modifierIndexes.length; bit += 1) {
      const clientBit = modifierIndexes[bit]
      if (clientBit >= 0 && (serverModifiers & (2 ** bit)) !== 0) {
        clientModifiers |= 2 ** clientBit
      }
    }
    result[index + 4] = clientModifiers
  }
  return result
}
