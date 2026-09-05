import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type {
  WorkspaceEditPlannedStep,
  WorkspaceEditTransactionOutcome
} from '../../../../shared/language-server-workspace-edit'
import { planWorkspaceEdit, type WorkspaceEditPlanView } from './workspace-edit-plan'
import { openSemanticEditDrawer } from './semantic-workspace-edit-drawer-store'
import {
  runWorkspaceEditTransaction,
  type GuardedSemanticEditResult,
  type WorkspaceEditTransactionPorts
} from './workspace-edit-transaction'
import {
  getWorkspaceEditUndoStack,
  undoLatestWorkspaceEdit,
  type WorkspaceEditUndoStack
} from './workspace-edit-undo-stack'
import { projectCommittedWorkspaceEdit } from './workspace-edit-store-projection'
import type { OpenFile } from '@/store/slices/editor'

/** Tier-1 shortcut (#20): an edit touching only the current document applies
 * to the draft as one Monaco undo group instead of a filesystem transaction.
 * Anything multi-file, resource-shaped, or version-pinned-to-stale goes null
 * and the caller escalates to the guarded flow. */
export function singleDocumentWorkspaceEdits(
  edit: WorkspaceEdit,
  currentUri: string,
  options: { syncedVersion?: number | null } = {}
): TextEdit[] | null {
  const collect = (edits: readonly TextEdit[]): TextEdit[] | null =>
    edits.length > 0 ? [...edits] : null
  if (edit.documentChanges) {
    const merged: TextEdit[] = []
    for (const change of edit.documentChanges) {
      if (!('textDocument' in change) || change.textDocument.uri !== currentUri) {
        return null
      }
      const version = change.textDocument.version
      if (
        typeof version === 'number' &&
        options.syncedVersion != null &&
        version !== options.syncedVersion
      ) {
        return null
      }
      merged.push(...(change.edits.filter((candidate) => 'newText' in candidate) as TextEdit[]))
    }
    return collect(merged)
  }
  const uris = Object.keys(edit.changes ?? {})
  return uris.length === 1 && uris[0] === currentUri
    ? collect(edit.changes![currentUri].filter((candidate) => 'newText' in candidate) as TextEdit[])
    : null
}

/** Everything the guarded flow needs to land an edit for one scope. */
export type SemanticWorkspaceEditContext = {
  operationHostId: ExecutionHostId
  view: WorkspaceEditPlanView
  ports: WorkspaceEditTransactionPorts
  /** Omitted in the renderer: the #38 preview drawer drives confirmation. */
  confirm?: (proposal: {
    steps: readonly WorkspaceEditPlannedStep[]
    scope: CodeIntelligenceScope
    operationHostId: ExecutionHostId
  }) => Promise<boolean>
  openFiles: readonly OpenFile[]
  worktreePathFor: (worktreeId: string) => string | null
}

export type SemanticEditProjectionArgs = {
  openFiles: readonly OpenFile[]
  worktreePathFor: (worktreeId: string) => string | null
}

/**
 * Tier-2 pipeline (#20/#36/#38): plan → preview confirmation → guarded journal
 * transaction → projection + session undo record. Without an injected confirm,
 * the #38 preview drawer owns the whole loop (review, conflict refresh, apply
 * progress, undo, recovery); nothing touches the host before it resolves true.
 */
export async function commitGuardedWorkspaceEdit(
  args: {
    edit: WorkspaceEdit
    scope: CodeIntelligenceScope
    operationHostId: ExecutionHostId
    view: WorkspaceEditPlanView
    ports: WorkspaceEditTransactionPorts
    confirm?: (proposal: {
      steps: readonly WorkspaceEditPlannedStep[]
      scope: CodeIntelligenceScope
      operationHostId: ExecutionHostId
    }) => Promise<boolean>
    stack?: WorkspaceEditUndoStack
    project?: (steps: readonly WorkspaceEditPlannedStep[]) => void
    now?: () => number
  } & SemanticEditProjectionArgs
): Promise<GuardedSemanticEditResult> {
  if (!args.confirm) {
    return openSemanticEditDrawer(args)
  }
  const plan = await planWorkspaceEdit({
    edit: args.edit,
    scope: args.scope,
    operationHostId: args.operationHostId,
    view: args.view
  })
  if (plan.status === 'blocked') {
    return { kind: 'outcome', outcome: { status: 'blocked', blocks: plan.blocks } }
  }
  const confirmed = await args.confirm({
    steps: plan.steps,
    scope: args.scope,
    operationHostId: args.operationHostId
  })
  if (!confirmed) {
    return { kind: 'cancelled' }
  }
  const outcome = await runWorkspaceEditTransaction({
    steps: plan.steps,
    scope: args.scope,
    operationHostId: args.operationHostId,
    ports: args.ports,
    now: args.now
  })
  if (outcome.status === 'committed') {
    ;(args.stack ?? getWorkspaceEditUndoStack()).push(outcome.undo)
    projectSteps(args, outcome.undo.steps)
  }
  return { kind: 'outcome', outcome }
}

/** Session-global undo (#36): pops the latest inverse, revalidates targets,
 * and re-projects so open editors reload the restored content. */
export async function undoLatestSemanticWorkspaceEdit(
  args: {
    ports: WorkspaceEditTransactionPorts
    stack?: WorkspaceEditUndoStack
    project?: (steps: readonly WorkspaceEditPlannedStep[]) => void
  } & SemanticEditProjectionArgs
): Promise<GuardedSemanticEditResult> {
  const outcome = await undoLatestWorkspaceEdit({ ports: args.ports, stack: args.stack })
  if (outcome && outcome.status === 'committed') {
    projectSteps(args, outcome.undo.steps)
  }
  return { kind: 'outcome', outcome }
}

export function describeSemanticEditOutcome(
  outcome: WorkspaceEditTransactionOutcome | null
): string {
  if (!outcome) {
    return 'no edit ran'
  }
  if (outcome.status === 'committed') {
    return 'committed'
  }
  if (outcome.status === 'blocked') {
    return outcome.blocks.map((block) => `${block.reason}: ${block.hostPath}`).join(', ')
  }
  return outcome.error
}

function projectSteps(
  args: SemanticEditProjectionArgs & {
    project?: (steps: readonly WorkspaceEditPlannedStep[]) => void
  },
  steps: readonly WorkspaceEditPlannedStep[]
): void {
  if (args.project) {
    args.project(steps)
    return
  }
  projectCommittedWorkspaceEdit({
    steps,
    openFiles: args.openFiles,
    worktreePathFor: args.worktreePathFor
  })
}
