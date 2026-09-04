import type * as Monaco from 'monaco-editor'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'
import { toServerFileUri } from './language-server-document-uri'
import {
  createSemanticEditingRequests,
  type SemanticEditingSession
} from './semantic-editing-requests'
import {
  installSemanticMonacoProviders,
  type SemanticMonacoLanguageApi,
  type SemanticMonacoLanding
} from './semantic-monaco-providers'
import {
  semanticDocumentEditorFor
} from './semantic-monaco-documents'
import {
  applySemanticWorkspaceEdit,
  worktreeIdOf,
  runSemanticCodeAction,
  semanticWorkspaceEditContextFor,
  type SemanticEditLandingResult
} from './semantic-edit-landing'

/** Per-language facts; everything else in this assembly is stack-agnostic. */
export type SemanticMonacoStackProfile = {
  serverLabel: string
  languages: readonly string[]
  findScope: (request: CodeIntelligenceDocumentRequest) => CodeIntelligenceScope | null
  session: () => SemanticEditingSession & {
    activeClient(scopeId: string):
      | { client: { sync: { syncedVersionFor(uri: string): number | null } } }
      | undefined
  }
}

/** Builds the Monaco editing-provider assembly (completion, formatting,
 * rename, code actions, applyEdit interception) for one language stack. */
export function createSemanticMonacoStack(profile: SemanticMonacoStackProfile) {
  const requests = createSemanticEditingRequests(profile.session)
  const { findScope } = profile

  const syncedVersionFor = (scopeId: string, hostPath: string): number | null =>
    profile.session().activeClient(scopeId)?.client.sync.syncedVersionFor(
      toServerFileUri(hostPath)
    ) ?? null

  const apiFor = (monacoLanguage: string): SemanticMonacoLanguageApi => ({
    monacoLanguage,
    getCompletion: (request, context, token) => requests.getCompletion(request, context, token),
    getSignatureHelp: (request, token) => requests.getSignatureHelp(request, token),
    getFormattingEdits: (request, options, token) =>
      requests.getFormattingEdits(request, options, token),
    getRangeFormattingEdits: (request, range, options, token) =>
      requests.getRangeFormattingEdits(request, range, options, token),
    getRenameEdit: (request, newName, token) => requests.getRenameEdit(request, newName, token),
    getCodeActions: (request, range, diagnostics, only, token) =>
      requests.getCodeActions(request, range, diagnostics, only, token),
    formatOnSaveEnabled: (request) => findScope(request)?.formatOnSave === true
  })

  const landing: SemanticMonacoLanding = {
    applyWorkspaceEdit: async (
      request,
      edit
    ): Promise<SemanticEditLandingResult> => {
      const scope = findScope(request)
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
      const scope = findScope(request)
      const document = scope && semanticDocumentEditorFor(request.fileId)
      if (!scope || !document) {
        return
      }
      await runSemanticCodeAction({
        request,
        scope,
        action,
        serverLabel: profile.serverLabel,
        editor: document.editor,
        model: document.model,
        syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath),
        resolveAction: (candidate) => requests.resolveCodeAction(request, candidate),
        executeServerCommand: async (command) => {
          await requests.executeServerCommand(request, command.command, command.arguments ?? [])
        }
      })
    },
    syncedVersionFor: (request) => {
      const scope = findScope(request)
      return scope ? syncedVersionFor(scope.id, request.filePath) : null
    }
  }

  return {
    installProviders(monaco: typeof Monaco): void {
      for (const language of profile.languages) {
        installSemanticMonacoProviders(monaco, apiFor(language), landing)
      }
      requests.installWorkspaceApplyEditInterceptor((scope) => {
        return semanticWorkspaceEditContextFor({
          worktreeId: worktreeIdOf(scope),
          scope,
          syncedVersionFor: (hostPath) => syncedVersionFor(scope.id, hostPath)
        })
      })
    }
  }
}
