import type * as Monaco from 'monaco-editor'
import type { Hover, MarkedString, Range as LspRange } from 'vscode-languageserver-protocol'
import { translate } from '@/i18n/i18n'
import type { CppDefinitionTarget } from './cpp-definition-locations'
import { installCppDefinitionLinkAffordance } from './cpp-definition-link-affordance'
import { installCppSemanticHighlightDecorations } from './cpp-semantic-highlight-decorations'
import { CPP_LANGUAGES } from './cpp-code-intelligence-workspace'
import {
  getCppHover,
  openCppDefinitionTarget,
  type CppCodeIntelligenceRequest
} from './cpp-definition-navigation'
import {
  installCppSemanticMonacoProviders,
  registerCppSemanticMonacoDocument
} from './cpp-monaco-semantic-providers'

type MonacoApi = typeof Monaco
type DocumentContext = {
  token: symbol
  requestAt: (position: Monaco.IPosition) => CppCodeIntelligenceRequest | null
}

const documents = new Map<string, DocumentContext>()
let installed = false

function toMonacoRange(monaco: MonacoApi, range: LspRange): Monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  )
}

function toLspRange(range: Monaco.IRange | Monaco.IPosition): LspRange {
  if ('startLineNumber' in range) {
    return {
      start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
      end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
    }
  }
  return {
    start: { line: range.lineNumber - 1, character: range.column - 1 },
    end: { line: range.lineNumber - 1, character: range.column - 1 }
  }
}

function markedStringValue(value: MarkedString): string {
  return typeof value === 'string' ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

function hoverContents(hover: Hover): Monaco.IMarkdownString[] {
  const value = hover.contents
  const contents = Array.isArray(value)
    ? value.map(markedStringValue)
    : typeof value === 'string' || 'language' in value
      ? [markedStringValue(value)]
      : [value.value]
  const modifier = navigator.userAgent.includes('Mac') ? '\u2318' : 'Ctrl'
  contents.push(
    translate(
      'settings.codeIntelligence.definitionHoverHint',
      '{{value0}}+Click or F12 to go to definition',
      { value0: modifier }
    )
  )
  return contents.filter(Boolean).map((entry) => ({ value: entry }))
}

function contextForModel(model: Monaco.editor.ITextModel): DocumentContext | null {
  return documents.get(model.uri.toString()) ?? null
}

function installProviders(monaco: MonacoApi): void {
  if (installed) {
    return
  }
  installed = true
  installCppSemanticMonacoProviders(monaco)
  for (const language of CPP_LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position, token) => {
        const context = contextForModel(model)
        const request = context?.requestAt(position)
        if (!request || token.isCancellationRequested) {
          return null
        }
        const hover = await getCppHover(request)
        if (!hover || token.isCancellationRequested) {
          return null
        }
        return {
          contents: hoverContents(hover),
          range: hover.range ? toMonacoRange(monaco, hover.range) : undefined
        }
      }
    })
  }
  monaco.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selectionOrPosition) => {
      const model = source.getModel()
      const position = source.getPosition()
      if (!model || !position) {
        return false
      }
      const request = contextForModel(model)?.requestAt(position)
      if (!request) {
        return false
      }
      const target: CppDefinitionTarget = {
        uri: resource.toString(),
        range: toLspRange(selectionOrPosition ?? { lineNumber: 1, column: 1 })
      }
      return openCppDefinitionTarget(request, target)
    }
  })
}

export function registerCppMonacoDocument(
  monaco: MonacoApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: DocumentContext['requestAt']
): () => void {
  installProviders(monaco)
  const model = editor.getModel()
  if (!model) {
    return () => undefined
  }
  const key = model.uri.toString()
  const context = { token: Symbol(key), requestAt }
  documents.set(key, context)
  const unregisterSemantic = registerCppSemanticMonacoDocument(editor, requestAt)
  const uninstallDefinitionLink = installCppDefinitionLinkAffordance(monaco, editor, requestAt)
  const uninstallSemanticHighlights = installCppSemanticHighlightDecorations(
    monaco,
    editor,
    requestAt
  )
  return () => {
    unregisterSemantic()
    uninstallDefinitionLink()
    uninstallSemanticHighlights()
    if (documents.get(key)?.token === context.token) {
      documents.delete(key)
    }
  }
}
