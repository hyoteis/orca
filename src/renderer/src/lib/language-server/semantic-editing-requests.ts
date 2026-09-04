import {
  CodeActionRequest,
  CodeActionResolveRequest,
  CompletionRequest,
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  ExecuteCommandRequest,
  RenameRequest,
  SignatureHelpRequest,
  type ApplyWorkspaceEditResult,
  type CancellationToken,
  type CodeAction,
  type CodeActionKind,
  type Command,
  type CompletionContext,
  type CompletionItem,
  type CompletionList,
  type Diagnostic,
  type FormattingOptions,
  type Range,
  type SignatureHelp,
  type TextEdit,
  type WorkspaceEdit
} from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'
import { toServerFileUri } from './language-server-document-uri'
import {
  commitGuardedWorkspaceEdit,
  describeSemanticEditOutcome,
  type SemanticWorkspaceEditContext
} from './semantic-workspace-edit-flow'
import type { SemanticServerCapabilities } from './semantic-editing-capabilities'

export type { SemanticWorkspaceEditContext }

/** What each language stack's session must expose for semantic editing;
 * both Cpp and Python sessions satisfy this structurally. */
export type SemanticEditingSession = {
  semanticRequest<Result>(
    request: CodeIntelligenceDocumentRequest,
    type: { method: string },
    params: object,
    options?: {
      capability?: keyof SemanticServerCapabilities
      satisfies?: (capabilities: SemanticServerCapabilities) => boolean
      token?: CancellationToken
    }
  ): Promise<{ scope: CodeIntelligenceScope; result: Result } | null>
  setWorkspaceApplyEditHandler(
    handler:
      | ((scope: CodeIntelligenceScope, edit: WorkspaceEdit) => Promise<ApplyWorkspaceEditResult>)
      | null
  ): void
}

const positionOf = (request: CodeIntelligenceDocumentRequest) => ({
  line: request.lineNumber - 1,
  character: request.column - 1
})

/** Capability-gated LSP editing requests shared by every language stack;
 * the session getter keeps the per-language singleton live across resets. */
export function createSemanticEditingRequests(getSession: () => SemanticEditingSession) {
  async function getCompletion(
    request: CodeIntelligenceDocumentRequest,
    context: CompletionContext,
    token?: CancellationToken
  ): Promise<CompletionItem[] | null> {
    const prepared = await getSession().semanticRequest<CompletionList | CompletionItem[] | null>(
      request,
      CompletionRequest.type,
      {
        textDocument: { uri: toServerFileUri(request.filePath) },
        position: positionOf(request),
        context
      },
      { capability: 'completion', token }
    )
    if (!prepared) {
      return null
    }
    return Array.isArray(prepared.result) ? prepared.result : (prepared.result?.items ?? [])
  }

  async function getSignatureHelp(
    request: CodeIntelligenceDocumentRequest,
    token?: CancellationToken
  ): Promise<SignatureHelp | null> {
    const prepared = await getSession().semanticRequest<SignatureHelp>(
      request,
      SignatureHelpRequest.type,
      {
        textDocument: { uri: toServerFileUri(request.filePath) },
        position: positionOf(request)
      },
      { capability: 'signatureHelp', token }
    )
    return prepared?.result ?? null
  }

  async function getFormattingEdits(
    request: CodeIntelligenceDocumentRequest,
    options: FormattingOptions,
    token?: CancellationToken
  ): Promise<TextEdit[] | null> {
    const prepared = await getSession().semanticRequest<TextEdit[] | null>(
      request,
      DocumentFormattingRequest.type,
      { textDocument: { uri: toServerFileUri(request.filePath) }, options },
      { capability: 'documentFormatting', token }
    )
    return (prepared?.result ?? []).length > 0 ? prepared!.result : null
  }

  async function getRangeFormattingEdits(
    request: CodeIntelligenceDocumentRequest,
    range: Range,
    options: FormattingOptions,
    token?: CancellationToken
  ): Promise<TextEdit[] | null> {
    const prepared = await getSession().semanticRequest<TextEdit[] | null>(
      request,
      DocumentRangeFormattingRequest.type,
      { textDocument: { uri: toServerFileUri(request.filePath) }, range, options },
      { capability: 'documentRangeFormatting', token }
    )
    return (prepared?.result ?? []).length > 0 ? prepared!.result : null
  }

  async function getRenameEdit(
    request: CodeIntelligenceDocumentRequest,
    newName: string,
    token?: CancellationToken
  ): Promise<WorkspaceEdit | null> {
    const prepared = await getSession().semanticRequest<WorkspaceEdit | null>(
      request,
      RenameRequest.type,
      {
        textDocument: { uri: toServerFileUri(request.filePath) },
        position: positionOf(request),
        newName
      },
      { capability: 'rename', token }
    )
    const edit = prepared?.result ?? null
    return edit && Object.keys(edit.changes ?? {}).length + (edit.documentChanges?.length ?? 0) > 0
      ? edit
      : null
  }

  async function getCodeActions(
    request: CodeIntelligenceDocumentRequest,
    range: Range,
    diagnostics: Diagnostic[],
    only: CodeActionKind[] | undefined,
    token?: CancellationToken
  ): Promise<(CodeAction | Command)[] | null> {
    const prepared = await getSession().semanticRequest<(CodeAction | Command)[] | null>(
      request,
      CodeActionRequest.type,
      {
        textDocument: { uri: toServerFileUri(request.filePath) },
        range,
        context: { diagnostics, only }
      },
      { capability: 'codeAction', token }
    )
    return (prepared?.result ?? []).length > 0 ? prepared!.result : null
  }

  async function resolveCodeAction(
    request: CodeIntelligenceDocumentRequest,
    action: CodeAction,
    token?: CancellationToken
  ): Promise<CodeAction> {
    const prepared = await getSession().semanticRequest<CodeAction>(
      request,
      CodeActionResolveRequest.type,
      { item: action },
      { capability: 'codeActionResolve', token }
    )
    return prepared?.result ?? action
  }

  async function executeServerCommand(
    request: CodeIntelligenceDocumentRequest,
    command: string,
    commandArguments: readonly unknown[],
    token?: CancellationToken
  ): Promise<unknown | null> {
    const prepared = await getSession().semanticRequest<unknown>(
      request,
      ExecuteCommandRequest.type,
      { command, arguments: [...commandArguments] },
      {
        // #20: server-declared command list is the allowed set.
        capability: 'executeCommand',
        satisfies: (capabilities) => capabilities.executeCommands.includes(command),
        token
      }
    )
    return prepared?.result ?? null
  }

  /**
   * workspace/applyEdit interception (#37): server-initiated edits never bypass
   * the guarded transaction; the scope's context resolver supplies host ports.
   */
  function installWorkspaceApplyEditInterceptor(contextFor: (
    scope: CodeIntelligenceScope
  ) => SemanticWorkspaceEditContext | null): void {
    getSession().setWorkspaceApplyEditHandler(async (scope, edit) => {
      const context = contextFor(scope)
      if (!context) {
        return { applied: false, failureReason: 'no guarded-edit context for this scope' }
      }
      const result = await commitGuardedWorkspaceEdit({ edit, scope, ...context })
      if (result.kind === 'cancelled') {
        return { applied: false, failureReason: 'declined' }
      }
      return {
        applied: result.outcome?.status === 'committed',
        failureReason:
          result.outcome?.status === 'committed' ? undefined : describeSemanticEditOutcome(result.outcome)
      }
    })
  }

  return {
    getCompletion,
    getSignatureHelp,
    getFormattingEdits,
    getRangeFormattingEdits,
    getRenameEdit,
    getCodeActions,
    resolveCodeAction,
    executeServerCommand,
    installWorkspaceApplyEditInterceptor
  }
}
