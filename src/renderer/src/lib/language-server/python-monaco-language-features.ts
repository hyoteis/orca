import type * as Monaco from 'monaco-editor'
import {
  CancellationTokenSource,
  type CancellationToken,
  type Diagnostic,
  type DocumentSymbol,
  type SymbolInformation
} from 'vscode-languageserver-protocol'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  PYTHON_LANGUAGES,
  getPythonDiagnostics,
  getPythonDocumentSymbols,
  getPythonHover,
  getPythonReferences,
  getPythonSessionState,
  resolvePythonDefinition,
  subscribePythonDiagnostics,
  type PythonCodeIntelligenceRequest,
  type PythonDefinitionResult
} from './python-definition-navigation'
import {
  findCodeIntelligenceScope,
  openDefinitionTargetInWorkspace
} from './code-intelligence-workspace'
import { installDefinitionLinkAffordance } from './definition-link-affordance'
import { toServerFileUri } from './language-server-document-uri'
import {
  installPythonSemanticMonacoProviders,
  registerPythonSemanticMonacoDocument
} from './python-monaco-semantic-providers'

type MonacoApi = typeof Monaco
type DocumentContext = {
  token: symbol
  requestAt: (position: Monaco.IPosition) => PythonCodeIntelligenceRequest | null
}

const documents = new Map<string, DocumentContext>()
let installed = false

// LSP severity 1..4 (Error..Hint) → monaco MarkerSeverity (8,4,2,1).
const LSP_TO_MONACO_SEVERITY = [8, 4, 2, 1]

function toMonacoRange(range: {
  start: { line: number; character: number }
  end: { line: number; character: number }
}): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

export function lspDiagnosticToMonacoMarkers(
  diagnostics: Diagnostic[]
): Monaco.editor.IMarkerData[] {
  return diagnostics.map((diagnostic) => ({
    ...toMonacoRange(diagnostic.range),
    message:
      typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
    // Missing severity defaults to Error, mirroring vscode-languageclient.
    severity: (LSP_TO_MONACO_SEVERITY[(diagnostic.severity ?? 1) - 1] ?? 8) as Monaco.MarkerSeverity,
    source: diagnostic.source
  }))
}

// LSP SymbolKind 1..26 and monaco SymbolKind 0..25 share ordering.
function monacoSymbolTags(symbol: { deprecated?: boolean }): Monaco.languages.SymbolTag[] {
  return symbol.deprecated ? [1 satisfies Monaco.languages.SymbolTag] : []
}

export function lspSymbolsToMonaco(
  symbols: DocumentSymbol[] | SymbolInformation[]
): Monaco.languages.DocumentSymbol[] {
  return symbols.map((symbol) =>
    'location' in symbol
      ? {
          name: symbol.name,
          detail: symbol.containerName ?? '',
          kind: (symbol.kind - 1) as Monaco.languages.SymbolKind,
          tags: monacoSymbolTags(symbol),
          range: toMonacoRange(symbol.location.range),
          selectionRange: toMonacoRange(symbol.location.range)
        }
      : {
          name: symbol.name,
          detail: symbol.detail ?? '',
          kind: (symbol.kind - 1) as Monaco.languages.SymbolKind,
          tags: monacoSymbolTags(symbol),
          range: toMonacoRange(symbol.range),
          selectionRange: toMonacoRange(symbol.selectionRange),
          children: symbol.children ? lspSymbolsToMonaco(symbol.children) : undefined
        }
  )
}

function toLspCancellationToken(token: Monaco.CancellationToken): CancellationToken {
  const source = new CancellationTokenSource()
  token.onCancellationRequested(() => source.cancel())
  return source.token
}

function hoverToContents(hover: { contents: unknown }): Monaco.IMarkdownString[] {
  const value = hover.contents
  const markedString = (entry: string | { language: string; value: string }): string =>
    typeof entry === 'string' ? entry : `\`\`\`${entry.language}\n${entry.value}\n\`\`\``
  const entries: string[] =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.map(markedString)
        : [value as { value: string }].map((entry) => entry.value)
  const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
  entries.push(
    translate(
      'settings.codeIntelligence.definitionHoverHint',
      '{{value0}}+Click or F12 to go to definition',
      { value0: modifier }
    )
  )
  return entries.filter(Boolean).map((entry) => ({ value: entry }))
}

function contextForModel(model: Monaco.editor.ITextModel): DocumentContext | null {
  return documents.get(model.uri.toString()) ?? null
}

/**
 * #13 fallback contract: a missing/unavailable/definition-incapable server
 * routes to the labelled text search; a semantic no-result never silently
 * degrades, it offers the search explicitly.
 */
export function pythonDefinitionFallbackAction(
  request: PythonCodeIntelligenceRequest
): { type: 'text-search' } | { type: 'offer-search' } | null {
  if (!PYTHON_LANGUAGES.has(request.language)) {
    return null
  }
  const state = getPythonSessionState(request)
  return state.quality === 'semantic' && state.capabilities?.definition
    ? { type: 'offer-search' }
    : { type: 'text-search' }
}

export function textSearchFallback(
  request: PythonCodeIntelligenceRequest,
  word: string | null
): void {
  if (!PYTHON_LANGUAGES.has(request.language) || !word) {
    return
  }
  toast.info(
    translate('settings.codeIntelligence.textMatchesFallback', 'Text matches (non-semantic)')
  )
  useAppStore.getState().showRightSidebarSearch({ query: word })
}

function offerSemanticSearch(
  request: PythonCodeIntelligenceRequest,
  word: string | null
): void {
  toast.info(translate('settings.codeIntelligence.noSemanticDefinition', 'No definition found'), {
    action: {
      label: translate(
        'settings.codeIntelligence.searchTextForSymbol',
        'Search text for symbol'
      ),
      onClick: () => textSearchFallback(request, word)
    }
  })
}

export function openPythonDefinitionTarget(
  request: PythonCodeIntelligenceRequest,
  result: PythonDefinitionResult
): boolean {
  const scope = findCodeIntelligenceScope(request, 'python')
  if (!scope) {
    return false
  }
  if (result.external) {
    toast.info(translate('settings.codeIntelligence.externalDependency', 'External dependency'))
  }
  return openDefinitionTargetInWorkspace(request, result.target, scope)
}

function installProviders(monaco: MonacoApi): void {
  if (installed) {
    return
  }
  installed = true
  installPythonSemanticMonacoProviders(monaco)
  monaco.languages.registerHoverProvider('python', {
    provideHover: async (model, position, token) => {
      const request = contextForModel(model)?.requestAt(position)
      if (!request || token.isCancellationRequested) {
        return null
      }
      const hover = await getPythonHover(request, toLspCancellationToken(token)).catch(
        () => null
      )
      if (!hover || token.isCancellationRequested) {
        return null
      }
      return {
        contents: hoverToContents(hover),
        range: hover.range ? toMonacoRange(hover.range) : undefined
      }
    }
  })
  monaco.languages.registerDocumentSymbolProvider('python', {
    provideDocumentSymbols: async (model, token) => {
      const request = contextForModel(model)?.requestAt({ lineNumber: 1, column: 1 })
      if (!request || token.isCancellationRequested) {
        return []
      }
      const symbols = await getPythonDocumentSymbols(
        request,
        toLspCancellationToken(token)
      ).catch(() => null)
      return symbols ? lspSymbolsToMonaco(symbols) : []
    }
  })
  monaco.languages.registerReferenceProvider('python', {
    provideReferences: async (model, position, _context, token) => {
      const request = contextForModel(model)?.requestAt(position)
      if (!request || token.isCancellationRequested) {
        return []
      }
      const references = await getPythonReferences(
        request,
        toLspCancellationToken(token)
      ).catch(() => null)
      if (references === null) {
        // No semantic session: route to the labelled text search (#13).
        const word = model.getWordAtPosition(position)?.word ?? null
        textSearchFallback(request, word)
        return []
      }
      return references.map((location) => ({
        uri: monaco.Uri.parse(location.uri),
        range: toMonacoRange(location.range)
      }))
    }
  })
}

export function registerPythonMonacoDocument(
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
  const unregisterSemantic = registerPythonSemanticMonacoDocument(editor, requestAt)
  const uninstallAffordance = installDefinitionLinkAffordance(monaco, editor, requestAt, {
    actionId: 'orca.goToDefinition.python',
    resolve: resolvePythonDefinition,
    open: openPythonDefinitionTarget,
    onNoResult: (request, word) => {
      const action = pythonDefinitionFallbackAction(request)
      if (action?.type === 'text-search') {
        textSearchFallback(request, word)
      } else if (action) {
        offerSemanticSearch(request, word)
      }
    }
  })
  const refreshDiagnostics = async (): Promise<void> => {
    const request = requestAt({ lineNumber: 1, column: 1 })
    if (!request || documents.get(key)?.token !== context.token) {
      return
    }
    const diagnostics = await getPythonDiagnostics(request)
    // The document may have re-registered while pulling; don't paint stale markers.
    if (documents.get(key)?.token !== context.token) {
      return
    }
    monaco.editor.setModelMarkers(
      model,
      'orca-python',
      lspDiagnosticToMonacoMarkers(diagnostics)
    )
  }
  const unsubscribeDiagnostics = subscribePythonDiagnostics((uri) => {
    const request = requestAt({ lineNumber: 1, column: 1 })
    if (request && uri === toServerFileUri(request.filePath)) {
      void refreshDiagnostics()
    }
  })
  void refreshDiagnostics()
  return () => {
    unregisterSemantic()
    unsubscribeDiagnostics()
    uninstallAffordance()
    if (documents.get(key)?.token === context.token) {
      documents.delete(key)
    }
    if (!documents.has(key)) {
      monaco.editor.setModelMarkers(model, 'orca-python', [])
    }
  }
}
