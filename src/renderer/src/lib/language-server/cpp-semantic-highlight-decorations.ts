import type * as Monaco from 'monaco-editor'
import { getCppSemanticTokens, type CppCodeIntelligenceRequest } from './cpp-definition-navigation'
import { CPP_SEMANTIC_TOKEN_TYPES } from './cpp-semantic-token-mapping'

type MonacoApi = typeof Monaco
type RequestAt = (position: Monaco.IPosition) => CppCodeIntelligenceRequest | null

type SemanticDecoration = {
  lineNumber: number
  startColumn: number
  endColumn: number
  className: string
}

const CLASS_BY_TOKEN_TYPE: Partial<Record<(typeof CPP_SEMANTIC_TOKEN_TYPES)[number], string>> = {
  namespace: 'orca-semantic-namespace',
  type: 'orca-semantic-type',
  class: 'orca-semantic-type',
  enum: 'orca-semantic-type',
  interface: 'orca-semantic-type',
  struct: 'orca-semantic-type',
  typeParameter: 'orca-semantic-type',
  dependentType: 'orca-semantic-type',
  concept: 'orca-semantic-type',
  parameter: 'orca-semantic-variable',
  variable: 'orca-semantic-variable',
  property: 'orca-semantic-variable',
  enumMember: 'orca-semantic-enum-member',
  function: 'orca-semantic-function',
  method: 'orca-semantic-function',
  macro: 'orca-semantic-macro'
}

export function decodeCppSemanticTokenDecorations(data: Uint32Array): SemanticDecoration[] {
  const decorations: SemanticDecoration[] = []
  let line = 0
  let start = 0
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index]
    line += deltaLine
    start = deltaLine === 0 ? start + data[index + 1] : data[index + 1]
    const length = data[index + 2]
    const tokenType = CPP_SEMANTIC_TOKEN_TYPES[data[index + 3]]
    const className = tokenType ? CLASS_BY_TOKEN_TYPE[tokenType] : undefined
    if (className && length > 0) {
      decorations.push({
        lineNumber: line + 1,
        startColumn: start + 1,
        endColumn: start + length + 1,
        className
      })
    }
  }
  return decorations
}

export function installCppSemanticHighlightDecorations(
  monaco: MonacoApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: RequestAt
): () => void {
  const decorations = editor.createDecorationsCollection()
  let generation = 0
  let refreshTimer: number | null = null

  const refresh = async (): Promise<void> => {
    const currentGeneration = ++generation
    const request = requestAt({ lineNumber: 1, column: 1 })
    if (!request) {
      decorations.clear()
      return
    }
    try {
      const data = await getCppSemanticTokens(request)
      if (!data || currentGeneration !== generation) {
        return
      }
      decorations.set(
        decodeCppSemanticTokenDecorations(data).map((decoration) => ({
          range: new monaco.Range(
            decoration.lineNumber,
            decoration.startColumn,
            decoration.lineNumber,
            decoration.endColumn
          ),
          options: { inlineClassName: decoration.className }
        }))
      )
    } catch (error) {
      console.warn('[code-intelligence] Semantic highlighting failed', error)
    }
  }

  const contentChange = editor.onDidChangeModelContent(() => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer)
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, 200)
  })
  void refresh()

  return () => {
    generation += 1
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer)
    }
    contentChange.dispose()
    decorations.clear()
  }
}
