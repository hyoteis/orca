import { createStore } from 'zustand'
import type { WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import type {
  WorkspaceEditBlockedTarget,
  WorkspaceEditPlannedStep,
  WorkspaceEditTransactionOutcome
} from '../../../../shared/language-server-workspace-edit'
import { planWorkspaceEdit, type WorkspaceEditPlanView } from './workspace-edit-plan'
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

/**
 * #38 preview drawer state machine: plan → review/conflicts (refreshable) →
 * apply → done (undoable) with incomplete rollback escalating to recovery.
 * `closeSemanticEditDrawer` resolves pre-apply phases as cancelled; busy
 * phases (applying/undoing) ignore close — the transaction is in flight.
 */
export type SemanticEditDrawerPhase =
  | { kind: 'planning' }
  | { kind: 'review'; steps: readonly WorkspaceEditPlannedStep[] }
  | { kind: 'conflicts'; blocks: readonly WorkspaceEditBlockedTarget[] }
  | { kind: 'applying'; steps: readonly WorkspaceEditPlannedStep[] }
  | { kind: 'undoing' }
  | {
      kind: 'done'
      outcome: Exclude<WorkspaceEditTransactionOutcome, { status: 'blocked' }>
      /** true when this done shows an undo's outcome, not the original apply. */
      undone?: boolean
    }
  | { kind: 'recovery'; outcome: Extract<WorkspaceEditTransactionOutcome, { status: 'failed' }> }

export type DrawerSession = {
  edit: WorkspaceEdit
  scope: CodeIntelligenceScope
  operationHostId: ExecutionHostId
  view: WorkspaceEditPlanView
  ports: WorkspaceEditTransactionPorts
  stack?: WorkspaceEditUndoStack
  openFiles: readonly OpenFile[]
  worktreePathFor: (worktreeId: string) => string | null
}

type DrawerState = {
  session: DrawerSession | null
  phase: SemanticEditDrawerPhase | null
  resolve: ((result: GuardedSemanticEditResult) => void) | null
}

export const semanticWorkspaceEditDrawerStore = createStore<DrawerState>(() => ({
  session: null,
  phase: null,
  resolve: null
}))

let sessionSeq = 0

const live = (): number => sessionSeq
const currentPhase = (): SemanticEditDrawerPhase | null =>
  semanticWorkspaceEditDrawerStore.getState().phase

/** Opens a session; supersedes (cancels) any unresolved one. */
export function openSemanticEditDrawer(args: DrawerSession): Promise<GuardedSemanticEditResult> {
  const state = semanticWorkspaceEditDrawerStore.getState()
  state.resolve?.({ kind: 'cancelled' })
  sessionSeq += 1
  const sessionId = sessionSeq
  return new Promise((resolve) => {
    semanticWorkspaceEditDrawerStore.setState({ session: args, phase: { kind: 'planning' }, resolve })
    void replan(sessionId)
  })
}

/** Conflict refresh: re-runs planning against the current view. */
export async function refreshSemanticEditDrawer(): Promise<void> {
  if (currentPhase()?.kind !== 'conflicts') {
    return
  }
  await replan(live())
}

/** Applies the reviewed steps; resolves with the transaction outcome. */
export async function applySemanticEditDrawerReview(): Promise<void> {
  const phase = currentPhase()
  if (phase?.kind !== 'review') {
    return
  }
  const { session } = semanticWorkspaceEditDrawerStore.getState()
  if (!session) {
    return
  }
  const sessionId = live()
  semanticWorkspaceEditDrawerStore.setState({ phase: { kind: 'applying', steps: phase.steps } })
  const outcome = await runWorkspaceEditTransaction({
    steps: phase.steps,
    scope: session.scope,
    operationHostId: session.operationHostId,
    ports: session.ports
  })
  if (sessionId !== live()) {
    return
  }
  transitionOutcome(outcome, session, sessionId)
}

/** Undoes the completed transaction from the done phase. */
export async function undoSemanticEditDrawerCompletion(): Promise<void> {
  const phase = currentPhase()
  if (phase?.kind !== 'done') {
    return
  }
  const { session } = semanticWorkspaceEditDrawerStore.getState()
  if (!session) {
    return
  }
  const sessionId = live()
  semanticWorkspaceEditDrawerStore.setState({ phase: { kind: 'undoing' } })
  const outcome = await undoLatestWorkspaceEdit({ ports: session.ports, stack: session.stack })
  if (sessionId !== live()) {
    return
  }
  if (!outcome) {
    semanticWorkspaceEditDrawerStore.setState({ phase: { kind: 'done', outcome: phase.outcome } })
    return
  }
  if (outcome.status === 'committed') {
    project(session, outcome.undo.steps)
    semanticWorkspaceEditDrawerStore.setState({
      phase: { kind: 'done', outcome, undone: true }
    })
    return
  }
  transitionOutcome(outcome, session, sessionId)
}

/** Close/cancel: pre-apply phases resolve cancelled; busy phases refuse. */
export function closeSemanticEditDrawer(): void {
  const phase = currentPhase()
  if (phase && (phase.kind === 'applying' || phase.kind === 'undoing')) {
    return
  }
  const { resolve } = semanticWorkspaceEditDrawerStore.getState()
  resolve?.({ kind: 'cancelled' })
  semanticWorkspaceEditDrawerStore.setState({ session: null, phase: null, resolve: null })
}

/** Test hook: drops any pending session, resolving it as cancelled. */
export function resetSemanticEditDrawerStore(): void {
  closeSemanticEditDrawer()
}

async function replan(sessionId: number): Promise<void> {
  const { session } = semanticWorkspaceEditDrawerStore.getState()
  if (!session || sessionId !== live()) {
    return
  }
  semanticWorkspaceEditDrawerStore.setState({ phase: { kind: 'planning' } })
  let outcome: WorkspaceEditTransactionOutcome | null
  let phase: SemanticEditDrawerPhase
  try {
    const plan = await planWorkspaceEdit({
      edit: session.edit,
      scope: session.scope,
      operationHostId: session.operationHostId,
      view: session.view
    })
    phase =
      plan.status === 'planned'
        ? { kind: 'review', steps: plan.steps }
        : { kind: 'conflicts', blocks: plan.blocks }
    outcome = null
  } catch (error) {
    // Defensive: a planning crash must not strand the awaiting caller.
    outcome = null
    phase = { kind: 'done', outcome: failedFromError(session, error) }
  }
  if (sessionId !== live()) {
    return
  }
  if (phase.kind === 'done') {
    semanticWorkspaceEditDrawerStore.getState().resolve?.({ kind: 'outcome', outcome })
    semanticWorkspaceEditDrawerStore.setState({ session: null, phase: null, resolve: null })
    return
  }
  semanticWorkspaceEditDrawerStore.setState({ phase })
}

function transitionOutcome(
  outcome: WorkspaceEditTransactionOutcome,
  session: DrawerSession,
  sessionId: number
): void {
  if (outcome.status === 'blocked') {
    semanticWorkspaceEditDrawerStore.setState({ phase: { kind: 'conflicts', blocks: outcome.blocks } })
    return
  }
  if (outcome.status === 'committed') {
    ;(session.stack ?? getWorkspaceEditUndoStack()).push(outcome.undo)
    project(session, outcome.undo.steps)
  }
  semanticWorkspaceEditDrawerStore.getState().resolve?.({ kind: 'outcome', outcome })
  semanticWorkspaceEditDrawerStore.setState({
    phase:
      outcome.status === 'failed' && !outcome.rolledBack
        ? { kind: 'recovery', outcome }
        : { kind: 'done', outcome }
    // The promise is settled; done/recovery stay purely informational.
    // Clearing resolve prevents a later close from double-settling.
  })
  if (sessionId === live()) {
    semanticWorkspaceEditDrawerStore.setState({ resolve: null })
  }
}

function project(session: DrawerSession, steps: readonly WorkspaceEditPlannedStep[]): void {
  projectCommittedWorkspaceEdit({
    steps,
    openFiles: session.openFiles,
    worktreePathFor: session.worktreePathFor
  })
}

function failedFromError(
  session: DrawerSession,
  error: unknown
): Extract<WorkspaceEditTransactionOutcome, { status: 'failed' }> {
  const message = error instanceof Error ? error.message : String(error)
  return {
    status: 'failed',
    error: message,
    rolledBack: true,
    steps: [],
    recovery: {
      capability: 'language-server.workspace-edit.v1' as const,
      scopeId: session.scope.id,
      executionHostId: session.scope.executionHostId,
      createdAt: Date.now(),
      error: message,
      entries: []
    }
  }
}
