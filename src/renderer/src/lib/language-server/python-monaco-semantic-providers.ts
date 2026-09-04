import type * as Monaco from 'monaco-editor'
import {
  findCodeIntelligenceScope,
  type CodeIntelligenceDocumentRequest
} from './code-intelligence-workspace'
import { toServerFileUri } from './language-server-document-uri'
import { getPythonCodeIntelligenceSession } from './python-code-intelligence-session'
import {
  executePythonServerCommand,
  getPythonCodeActions,
  getPythonCompletion,
  getPythonFormattingEdits,
  getPythonRangeFormattingEdits,
  getPythonRenameEdit,
  getPythonSignatureHelp,
  installPythonWorkspaceApplyEditInterceptor,
  resolvePythonCodeAction
} from './python-semantic-editing'
import {
  installSemanticMonacoProviders,
  type SemanticMonacoLanguageApi,
  type SemanticMonacoLanding
} from './semantic-monaco-providers'
import {
  registerSemanticMonacoDocument,
  semanticDocumentEditorFor
} from './semantic-monaco-documents'
import {
  applySemanticWorkspaceEdit,
  worktreeIdOf,
  runSemanticCodeAction,
  semanticWorkspaceEditContextFor,
  type SemanticEditLandingResult
} from './semantic-edit-landing'

const SERVER_LABEL = 'basedpyright'

const syncedVersionFor = (scopeId: string, hostPath: string): number | null =>
  getPythonCodeIntelligenceSession().activeClient(scopeId)?.client.sync.syncedVersionFor(
    toServerFileUri(hostPath)
  ) ?? null

const landingScope = (request: CodeIntelligenceDocumentRequest) =>
  findCodeIntelligenceScope(request, 'python')

const pythonApi: SemanticMonacoLanguageApi = {
  monacoLanguage: 'python',
  getCompletion: (request, context, token) => getPythonCompletion(request, context, token),
  getSignatureHelp: (request, token) => getPythonSignatureHelp(request, token),
  getFormattingEdits: (request, options, token) => getPythonFormattingEdits(request, options, token),
  getRangeFormattingEdits: (request, range, options, token) =>
    getPythonRangeFormattingEdits(request, range, options, token),
  getRenameEdit: (request, newName, token) => getPythonRenameEdit(request, newName, token),
  getCodeActions: (request, range, diagnostics, only, token) =>
    getPythonCodeActions(request, range, diagnostics, only, token),
  formatOnSaveEnabled: (request) => landingScope(request)?.formatOnSave === true
}

const pythonLanding: SemanticMonacoLanding = {
  applyWorkspaceEdit: async (request, edit): Promise<SemanticEditLandingResult> => {
    const scope = landingScope(request)
    const document = scope && semanticDocumentEditorFor(request.fileId)
    if (!scope || !document) {
      return 'blocked'
    }
    return applySemanticWorkspaceEdit({
      request,
      scope,
      edit,
      editor: document.editor,
      model: document.model,
      syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath)
    })
  },
  executeCodeAction: async (request, action) => {
    const scope = landingScope(request)
    const document = scope && semanticDocumentEditorFor(request.fileId)
    if (!scope || !document) {
      return
    }
    await runSemanticCodeAction({
      request,
      scope,
      action,
      serverLabel: SERVER_LABEL,
      editor: document.editor,
      model: document.model,
      syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath),
      resolveAction: (candidate) => resolvePythonCodeAction(request, candidate),
      executeServerCommand: async (command) => {
        await executePythonServerCommand(request, command.command, command.arguments ?? [])
      }
    })
  },
  syncedVersionFor: (request) => {
    const scope = landingScope(request)
    return scope ? syncedVersionFor(scope.id, request.filePath) : null
  }
}

export function installPythonSemanticMonacoProviders(monaco: typeof Monaco): void {
  installSemanticMonacoProviders(monaco, pythonApi, pythonLanding)
  installPythonWorkspaceApplyEditInterceptor((scope) => {
    return semanticWorkspaceEditContextFor({
      worktreeId: worktreeIdOf(scope),
      scope,
      syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath)
    })
  })
}

export function registerPythonSemanticMonacoDocument(
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: (position: Monaco.IPosition) => CodeIntelligenceDocumentRequest | null
): () => void {
  return registerSemanticMonacoDocument(editor, requestAt)
}
