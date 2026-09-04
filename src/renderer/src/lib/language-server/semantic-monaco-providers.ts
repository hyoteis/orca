import type * as Monaco from 'monaco-editor'
import type {
  CancellationToken,
  CodeAction,
  Command,
  CompletionContext,
  CompletionItem,
  Diagnostic,
  FormattingOptions,
  Range as LspRange,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'
import {
  lspToMonacoCompletionItem,
  lspToMonacoSignatureHelp,
  lspToMonacoTextEdit,
  monacoMarkerToLspDiagnostic,
  toLspCancellationToken
} from './lsp-monaco-conversions'
import { registerSemanticLanguageApi, requestAtPosition } from './semantic-monaco-documents'
import { singleDocumentWorkspaceEdits } from './semantic-workspace-edit-flow'
import type { SemanticEditLandingResult } from './semantic-edit-landing'

/** Per-language LSP request surface the providers drive. */
export type SemanticMonacoLanguageApi = {
  monacoLanguage: string
  getCompletion(
    request: CodeIntelligenceDocumentRequest,
    context: CompletionContext,
    token?: CancellationToken
  ): Promise<CompletionItem[] | null>
  getSignatureHelp(
    request: CodeIntelligenceDocumentRequest,
    token?: CancellationToken
  ): Promise<SignatureHelp | null>
  getFormattingEdits(
    request: CodeIntelligenceDocumentRequest,
    options: FormattingOptions,
    token?: CancellationToken
  ): Promise<TextEdit[] | null>
  getRangeFormattingEdits(
    request: CodeIntelligenceDocumentRequest,
    range: LspRange,
    options: FormattingOptions,
    token?: CancellationToken
  ): Promise<TextEdit[] | null>
  getRenameEdit(
    request: CodeIntelligenceDocumentRequest,
    newName: string,
    token?: CancellationToken
  ): Promise<WorkspaceEdit | null>
  getCodeActions(
    request: CodeIntelligenceDocumentRequest,
    range: LspRange,
    diagnostics: Diagnostic[],
    only: string[] | undefined,
    token?: CancellationToken
  ): Promise<(CodeAction | Command)[] | null>
  /** Per-scope format-on-save switch (#20); providers gate on it per request. */
  formatOnSaveEnabled(request: CodeIntelligenceDocumentRequest): boolean
}

/** Edit landing: wiring decides tier-1 (monaco undo group) vs tier-2 (guarded
 * journal transaction) and runs command-only actions after confirmation. */
export type SemanticMonacoLanding = {
  applyWorkspaceEdit(
    request: CodeIntelligenceDocumentRequest,
    edit: WorkspaceEdit
  ): Promise<SemanticEditLandingResult>
  executeCodeAction(request: CodeIntelligenceDocumentRequest, action: CodeAction | Command): Promise<void>
  syncedVersionFor(request: CodeIntelligenceDocumentRequest): number | null
}

export const SEMANTIC_CODE_ACTION_COMMAND = 'orca.semantic.codeAction'

/** Landing by monaco language id; code actions route their execution here. */
const commandLandings = new Map<string, SemanticMonacoLanding>()

let commandInstalled = false
const installedLanguages = new Set<string>()

const toLspRange = (range: Monaco.IRange): LspRange => ({
  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
})

function markersToDiagnostics(monaco: typeof Monaco, model: Monaco.editor.ITextModel): Diagnostic[] {
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .map(monacoMarkerToLspDiagnostic)
}

export function installSemanticMonacoProviders(
  monaco: typeof Monaco,
  api: SemanticMonacoLanguageApi,
  landing: SemanticMonacoLanding
): void {
  const language = api.monacoLanguage
  commandLandings.set(language, landing)
  registerSemanticLanguageApi(language, api)
  if (!commandInstalled) {
    commandInstalled = true
    monaco.editor.registerCommand(SEMANTIC_CODE_ACTION_COMMAND, (_accessor, payload: unknown) => {
      const args = payload as [CodeIntelligenceDocumentRequest, CodeAction | Command] | undefined
      const request = args?.[0]
      const action = args?.[1]
      if (!request || !action) {
        return
      }
      // The action carries the language it came from; request.language matches.
      void commandLandings.get(request.language)?.executeCodeAction(request, action)
    })
  }
  if (installedLanguages.has(language)) {
    return
  }
  installedLanguages.add(language)
  // monaco CompletionTriggerKind (0..2) → LSP CompletionTriggerKind (1..3).
  const TRIGGER_KIND = [1, 2, 3]
  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems: async (model, position, monacoContext, token) => {
      const request = requestAtPosition(model, position)
      if (!request || token.isCancellationRequested) {
        return { suggestions: [] }
      }
      const items = await api
        .getCompletion(
          request,
          {
            triggerKind: (TRIGGER_KIND[monacoContext.triggerKind] ?? 1) as 1 | 2 | 3,
            triggerCharacter: monacoContext.triggerCharacter
          },
          toLspCancellationToken(token)
        )
        .catch(() => null)
      if (!items || token.isCancellationRequested) {
        return { suggestions: [] }
      }
      const word = model.getWordUntilPosition(position)
      const wordRange: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn
      }
      return { suggestions: items.map((item) => lspToMonacoCompletionItem({ item, wordRange })) }
    }
  })

  monaco.languages.registerSignatureHelpProvider(language, {
    provideSignatureHelp: async (model, position, token) => {
      const request = requestAtPosition(model, position)
      if (!request || token.isCancellationRequested) {
        return null
      }
      const help = await api.getSignatureHelp(request).catch(() => null)
      return help && !token.isCancellationRequested
        ? { value: lspToMonacoSignatureHelp(help), dispose: () => {} }
        : null
    }
  })

  monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions: async (model, range, context, token) => {
      const request = requestAtPosition(model, {
        lineNumber: range.startLineNumber,
        column: range.startColumn
      })
      if (!request || token.isCancellationRequested) {
        return { actions: [], dispose: () => {} }
      }
      const actions = await api
        .getCodeActions(
          request,
          toLspRange(range),
          markersToDiagnostics(monaco, model),
          context.only ? [context.only] : undefined,
          token
        )
        .catch(() => null)
      const monacoActions: Monaco.languages.CodeAction[] = (actions ?? [])
        .filter((action): action is CodeAction | Command => Boolean(action && 'title' in action))
        .map((action) => ({
          title: action.title,
          kind: 'kind' in action ? action.kind : undefined,
          isPreferred: 'isPreferred' in action ? action.isPreferred : undefined,
          // Landing is the single execution path; monaco never runs server
          // commands directly.
          command: { id: SEMANTIC_CODE_ACTION_COMMAND, title: action.title, arguments: [request, action] }
        }))
      return { actions: monacoActions, dispose: () => {} }
    }
  })

  monaco.languages.registerRenameProvider(language, {
    provideRenameEdits: async (model, position, newName, token) => {
      const request = requestAtPosition(model, position)
      if (!request || token.isCancellationRequested) {
        return null
      }
      const edit = await api.getRenameEdit(request, newName, token).catch(() => null)
      if (!edit) {
        return null
      }
      // Stale bases apply misaligned ranges; drop instead of corrupting (#20).
      if (request.documentVersion !== model.getVersionId()) {
        return null
      }
      const uri = model.uri.toString()
      const single = singleDocumentWorkspaceEdits(edit, uri, {
        syncedVersion: landing.syncedVersionFor(request)
      })
      if (single === null) {
        // Tier-2: the guarded transaction owns the write; monaco applies nothing.
        await landing.applyWorkspaceEdit(request, edit)
        return { edits: [] }
      }
      return {
        edits: single.map((editItem) => ({
          resource: model.uri,
          textEdit: lspToMonacoTextEdit(editItem),
          versionId: undefined
        }))
      }
    }
  })

  const formattingOptions = (o: Monaco.languages.FormattingOptions): FormattingOptions => ({
    tabSize: o.tabSize,
    insertSpaces: o.insertSpaces
  })
  monaco.languages.registerDocumentFormattingEditProvider(language, {
    provideDocumentFormattingEdits: async (model, options, token) => {
      const request = requestAtPosition(model, { lineNumber: 1, column: 1 })
      if (!request || token.isCancellationRequested) {
        return []
      }
      const edits = await api
        .getFormattingEdits(request, formattingOptions(options), token)
        .catch(() => null)
      // Drop formatting results after the document moved (#20).
      return edits && request.documentVersion === model.getVersionId()
        ? edits.map(lspToMonacoTextEdit)
        : []
    }
  })
  monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
    provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
      const request = requestAtPosition(model, {
        lineNumber: range.startLineNumber,
        column: range.startColumn
      })
      if (!request || token.isCancellationRequested) {
        return []
      }
      const edits = await api
        .getRangeFormattingEdits(request, toLspRange(range), formattingOptions(options), token)
        .catch(() => null)
      return edits && request.documentVersion === model.getVersionId()
        ? edits.map(lspToMonacoTextEdit)
        : []
    }
  })
}

