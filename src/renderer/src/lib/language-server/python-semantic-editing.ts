import {
  CodeActionRequest,
  CodeActionResolveRequest,
  CompletionRequest,
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  ExecuteCommandRequest,
  RenameRequest,
  SignatureHelpRequest,
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
import { toServerFileUri } from './language-server-document-uri'
import { getPythonCodeIntelligenceSession } from './python-code-intelligence-session'
import type { PythonCodeIntelligenceRequest } from './python-code-intelligence-session'
import {
  commitGuardedWorkspaceEdit,
  describeSemanticEditOutcome,
  type SemanticWorkspaceEditContext
} from './semantic-workspace-edit-flow'

export type { SemanticWorkspaceEditContext }

const positionOf = (request: PythonCodeIntelligenceRequest) => ({
  line: request.lineNumber - 1,
  character: request.column - 1
})

export async function getPythonCompletion(
  request: PythonCodeIntelligenceRequest,
  context: CompletionContext,
  token?: CancellationToken
): Promise<CompletionItem[] | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<
    CompletionList | CompletionItem[] | null
  >(
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

export async function getPythonSignatureHelp(
  request: PythonCodeIntelligenceRequest,
  token?: CancellationToken
): Promise<SignatureHelp | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<SignatureHelp>(
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

export async function getPythonFormattingEdits(
  request: PythonCodeIntelligenceRequest,
  options: FormattingOptions,
  token?: CancellationToken
): Promise<TextEdit[] | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<TextEdit[] | null>(
    request,
    DocumentFormattingRequest.type,
    { textDocument: { uri: toServerFileUri(request.filePath) }, options },
    { capability: 'documentFormatting', token }
  )
  return (prepared?.result ?? []).length > 0 ? prepared!.result : null
}

export async function getPythonRangeFormattingEdits(
  request: PythonCodeIntelligenceRequest,
  range: Range,
  options: FormattingOptions,
  token?: CancellationToken
): Promise<TextEdit[] | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<TextEdit[] | null>(
    request,
    DocumentRangeFormattingRequest.type,
    { textDocument: { uri: toServerFileUri(request.filePath) }, range, options },
    { capability: 'documentRangeFormatting', token }
  )
  return (prepared?.result ?? []).length > 0 ? prepared!.result : null
}

export async function getPythonRenameEdit(
  request: PythonCodeIntelligenceRequest,
  newName: string,
  token?: CancellationToken
): Promise<WorkspaceEdit | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<WorkspaceEdit | null>(
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

export async function getPythonCodeActions(
  request: PythonCodeIntelligenceRequest,
  range: Range,
  diagnostics: Diagnostic[],
  only: CodeActionKind[] | undefined,
  token?: CancellationToken
): Promise<(CodeAction | Command)[] | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<
    (CodeAction | Command)[] | null
  >(
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

export async function resolvePythonCodeAction(
  request: PythonCodeIntelligenceRequest,
  action: CodeAction,
  token?: CancellationToken
): Promise<CodeAction> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<CodeAction>(
    request,
    CodeActionResolveRequest.type,
    { item: action },
    { capability: 'codeActionResolve', token }
  )
  return prepared?.result ?? action
}

export async function executePythonServerCommand(
  request: PythonCodeIntelligenceRequest,
  command: string,
  commandArguments: readonly unknown[],
  token?: CancellationToken
): Promise<unknown | null> {
  const prepared = await getPythonCodeIntelligenceSession().semanticRequest<unknown>(
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
export function installPythonWorkspaceApplyEditInterceptor(contextFor: (
  scope: CodeIntelligenceScope
) => SemanticWorkspaceEditContext | null): void {
  getPythonCodeIntelligenceSession().setWorkspaceApplyEditHandler(async (scope, edit) => {
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
