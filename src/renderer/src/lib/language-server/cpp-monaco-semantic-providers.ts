import type * as Monaco from 'monaco-editor'
import { CPP_LANGUAGES, findCppCodeIntelligenceScope, type CodeIntelligenceDocumentRequest } from './cpp-code-intelligence-workspace'
import { toServerFileUri } from './language-server-document-uri'
import { getCppSession } from './cpp-code-intelligence-session'
import {
  executeCppServerCommand,
  getCppCodeActions,
  getCppCompletion,
  getCppFormattingEdits,
  getCppRangeFormattingEdits,
  getCppRenameEdit,
  getCppSignatureHelp,
  installCppWorkspaceApplyEditInterceptor,
  resolveCppCodeAction
} from './cpp-semantic-editing'
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

const SERVER_LABEL = 'clangd'

const syncedVersionFor = (scopeId: string, hostPath: string): number | null =>
  getCppSession().activeClient(scopeId)?.client.sync.syncedVersionFor(
    toServerFileUri(hostPath)
  ) ?? null

const landingScope = (request: CodeIntelligenceDocumentRequest) =>
  findCppCodeIntelligenceScope(request)

const cppApi: SemanticMonacoLanguageApi = {
  monacoLanguage: 'cpp',
  getCompletion: (request, context, token) => getCppCompletion(request, context, token),
  getSignatureHelp: (request, token) => getCppSignatureHelp(request, token),
  getFormattingEdits: (request, options, token) => getCppFormattingEdits(request, options, token),
  getRangeFormattingEdits: (request, range, options, token) =>
    getCppRangeFormattingEdits(request, range, options, token),
  getRenameEdit: (request, newName, token) => getCppRenameEdit(request, newName, token),
  getCodeActions: (request, range, diagnostics, only, token) =>
    getCppCodeActions(request, range, diagnostics, only, token),
  formatOnSaveEnabled: (request) => landingScope(request)?.formatOnSave === true
}

const cppLanding: SemanticMonacoLanding = {
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
      resolveAction: (candidate) => resolveCppCodeAction(request, candidate),
      executeServerCommand: async (command) => {
        await executeCppServerCommand(request, command.command, command.arguments ?? [])
      }
    })
  },
  syncedVersionFor: (request) => {
    const scope = landingScope(request)
    return scope ? syncedVersionFor(scope.id, request.filePath) : null
  }
}

export function installCppSemanticMonacoProviders(monaco: typeof Monaco): void {
  for (const language of CPP_LANGUAGES) {
    installSemanticMonacoProviders(monaco, { ...cppApi, monacoLanguage: language }, cppLanding)
  }
  installCppWorkspaceApplyEditInterceptor((scope) => {
    return semanticWorkspaceEditContextFor({
      worktreeId: worktreeIdOf(scope),
      scope,
      syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath)
    })
  })
}

export function registerCppSemanticMonacoDocument(
  editor: Monaco.editor.IStandaloneCodeEditor,
  requestAt: (position: Monaco.IPosition) => CodeIntelligenceDocumentRequest | null
): () => void {
  return registerSemanticMonacoDocument(editor, requestAt)
}
