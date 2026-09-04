import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  confirmSemanticWorkspaceEditViaToast,
  confirmServerCommandViaToast
} from './semantic-edit-confirmation'
import type { CodeAction, Command } from 'vscode-languageserver-protocol'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { CodeIntelligenceDocumentRequest } from './code-intelligence-workspace'
import { toServerFileUri } from './language-server-document-uri'
import { applyDocumentTextEdits, type EditEditor, type EditModel } from './document-semantic-edits'
import {
  commitGuardedWorkspaceEdit,
  describeSemanticEditOutcome,
  singleDocumentWorkspaceEdits,
  undoLatestSemanticWorkspaceEdit,
  type SemanticWorkspaceEditContext
} from './semantic-workspace-edit-flow'
import {
  createWorkspaceEditEditorPorts,
  resolveWorkspaceEditOperationHostId
} from './workspace-edit-editor-ports'
import { CPP_LANGUAGES, findCppCodeIntelligenceScope } from './cpp-code-intelligence-workspace'
import { findCodeIntelligenceScope } from './code-intelligence-workspace'

export type SemanticEditLandingResult =
  | 'applied' // tier-1: one monaco undo group on the open draft
  | 'committed' // tier-2: guarded journal transaction committed
  | 'cancelled'
  | 'stale' // the document moved since the edit was computed
  | 'blocked'
  | 'failed'

/** Guarded-flow context from the live store; null when the owning workspace is
 * gone — the caller then disables the edit instead of writing blindly. */
export function semanticWorkspaceEditContextFor(args: {
  /** Owning worktree (or folder workspace key); scopes carry it in workspaceKey. */
  worktreeId: string | null
  scope: CodeIntelligenceScope
  syncedVersionFor: (hostPath: string) => number | null
  confirm?: SemanticWorkspaceEditContext['confirm']
}): SemanticWorkspaceEditContext | null {
  const state = useAppStore.getState()
  const repo = args.worktreeId
    ? state.repos.find((candidate) => candidate.id === args.worktreeId)
    : undefined
  const folder = args.worktreeId
    ? state.folderWorkspaces?.find(
        (candidate) => folderWorkspaceKey(candidate.id) === args.worktreeId
      )
    : undefined
  const worktreePath = repo?.path ?? folder?.folderPath ?? null
  if (!worktreePath) {
    return null
  }
  const runtimeContext = {
    settings: state.settings,
    worktreeId: args.worktreeId,
    worktreePath,
    connectionId: (repo?.connectionId ?? folder?.connectionId ?? undefined) || undefined,
    expectedExecutionHostId: (repo?.executionHostId ??
      folder?.executionHostId ??
      'local') as 'local' | `ssh:${string}`
  }
  const openFiles = () => state.openFiles
  const ports = createWorkspaceEditEditorPorts({
    context: runtimeContext,
    syncedDocumentFor: args.syncedVersionFor,
    openFiles
  })
  return {
    operationHostId: resolveWorkspaceEditOperationHostId(runtimeContext),
    view: ports,
    ports,
    confirm:
      args.confirm ??
      ((proposal) =>
        confirmSemanticWorkspaceEditViaToast({
          steps: proposal.steps,
          scope: { name: proposal.scope.name }
        })),
    openFiles: state.openFiles,
    worktreePathFor: (worktreeId) =>
      state.repos.find((candidate) => candidate.id === worktreeId)?.path ??
      state.folderWorkspaces?.find(
        (candidate) => folderWorkspaceKey(candidate.id) === worktreeId
      )?.folderPath ??
      null
  }
}

/**
 * Tier split (#20): same-document edits land on the open draft as one Monaco
 * undo group after version validation; anything wider routes through the
 * guarded journal transaction with confirmation.
 */
export async function applySemanticWorkspaceEdit(args: {
  request: CodeIntelligenceDocumentRequest
  scope: CodeIntelligenceScope
  edit: Parameters<typeof singleDocumentWorkspaceEdits>[0]
  editor: EditEditor
  model: EditModel & { uri: { toString(): string } }
  syncedVersionFor: (hostPath: string) => number | null
}): Promise<SemanticEditLandingResult> {
  const uri = toServerFileUri(args.request.filePath)
  const single = singleDocumentWorkspaceEdits(args.edit, uri, {
    syncedVersion: args.syncedVersionFor(args.request.filePath)
  })
  if (single !== null) {
    const applied = applyDocumentTextEdits({
      editor: args.editor,
      model: args.model,
      edits: single,
      baseVersion: args.request.documentVersion,
      source: 'orca.semanticEdit'
    })
    if (applied) {
      return 'applied'
    }
    toast.warning(
      translate(
        'settings.codeIntelligence.semanticEditStale',
        'Document changed — the edit was dropped, try again'
      )
    )
    return 'stale'
  }
  const context = semanticWorkspaceEditContextFor({
    worktreeId: args.request.worktreeId,
    scope: args.scope,
    syncedVersionFor: args.syncedVersionFor
  })
  if (!context) {
    return 'blocked'
  }
  const result = await commitGuardedWorkspaceEdit({
    edit: args.edit,
    scope: args.scope,
    operationHostId: context.operationHostId,
    view: context.view,
    ports: context.ports,
    confirm: context.confirm,
    openFiles: context.openFiles,
    worktreePathFor: context.worktreePathFor
  })
  if (result.kind === 'cancelled') {
    return 'cancelled'
  }
  switch (result.outcome?.status) {
    case 'committed':
      return 'committed'
    case 'blocked':
      toast.warning(
        translate(
          'settings.codeIntelligence.semanticEditBlocked',
          'Edit blocked: {{value0}}',
          {
            value0:
              result.outcome.status === 'blocked'
                ? describeSemanticEditOutcome(result.outcome)
                : ''
          }
        )
      )
      return 'blocked'
    default:
      toast.error(
        translate('settings.codeIntelligence.semanticEditFailed', 'Edit failed: {{value0}}', {
          value0: describeSemanticEditOutcome(result.outcome)
        })
      )
      return 'failed'
  }
}

/**
 * Code-action execution (#20): resolve first, then land the edit; command-only
 * actions ask for a second confirmation naming server and command, and any
 * server-initiated applyEdit from the command still routes through the guard.
 */
export async function runSemanticCodeAction(args: {
  request: CodeIntelligenceDocumentRequest
  scope: CodeIntelligenceScope
  action: CodeAction | Command
  serverLabel: string
  editor: EditEditor
  model: EditModel & { uri: { toString(): string } }
  syncedVersionFor: (hostPath: string) => number | null
  resolveAction: (action: CodeAction) => Promise<CodeAction>
  executeServerCommand: (command: Command) => Promise<void>
}): Promise<void> {
  let action: CodeAction | Command | undefined = args.action
  if ('kind' in action && !action.edit && !action.command) {
    action = await args.resolveAction(action)
  }
  if ('kind' in action && action.edit) {
    await applySemanticWorkspaceEdit({
      request: args.request,
      scope: args.scope,
      edit: action.edit,
      editor: args.editor,
      model: args.model,
      syncedVersionFor: args.syncedVersionFor
    })
    return
  }
  if (!action) {
    return
  }
  // `kind` is optional on CodeAction, so `in` alone does not narrow.
  const isCodeAction = (candidate: CodeAction | Command): candidate is CodeAction =>
    'kind' in candidate
  const command: Command | undefined = isCodeAction(action) ? action.command : action
  if (!command) {
    return
  }
  const confirmed = await confirmServerCommandViaToast({
    serverLabel: args.serverLabel,
    command: command.command,
    title: command.title
  })
  if (!confirmed) {
    return
  }
  await args.executeServerCommand(command)
}

/**
 * Session-global semantic undo (#20): revalidates every target through the
 * guarded transaction, so later conflicts block instead of overwriting.
 */
export async function undoLatestSemanticEditForRequest(
  request: CodeIntelligenceDocumentRequest
): Promise<'committed' | 'cancelled' | 'blocked' | 'failed' | 'nothing-to-undo'> {
  const scope = CPP_LANGUAGES.has(request.language)
    ? findCppCodeIntelligenceScope(request)
    : findCodeIntelligenceScope(request, 'python')
  if (!scope) {
    return 'nothing-to-undo'
  }
  const context = semanticWorkspaceEditContextFor({
    worktreeId: worktreeIdOf(scope),
    scope,
    syncedVersionFor: () => null
  })
  if (!context) {
    return 'blocked'
  }
  const result = await undoLatestSemanticWorkspaceEdit({
    ports: context.ports,
    openFiles: context.openFiles,
    worktreePathFor: context.worktreePathFor
  })
  if (result.kind !== 'outcome' || !result.outcome) {
    return result.kind === 'cancelled' ? 'cancelled' : 'nothing-to-undo'
  }
  switch (result.outcome.status) {
    case 'committed':
      return 'committed'
    case 'blocked':
      return 'blocked'
    default:
      return 'failed'
  }
}

/** Workspace key → owning worktree id (folder keys keep their prefix). */
export function worktreeIdOf(scope: CodeIntelligenceScope): string | null {
  const parsed = parseWorkspaceKey(scope.workspaceKey)
  return parsed
    ? parsed.type === 'worktree'
      ? parsed.worktreeId
      : folderWorkspaceKey(parsed.folderWorkspaceId)
    : null
}
