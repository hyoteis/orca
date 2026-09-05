import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  WORKSPACE_EDIT_CAPABILITY,
  type WorkspaceEditScopeRef,
  type WorkspaceEditBlockedTarget,
  type WorkspaceEditPlannedStep,
  type WorkspaceEditStepOutcome,
  type WorkspaceEditTransactionOutcome
} from '../../../../shared/language-server-workspace-edit'
import { authorizeWorkspaceEditTargets } from './workspace-edit-path-authorization'
import {
  buildWorkspaceEditRecoveryEntries,
  buildWorkspaceEditUndoEntry,
  type JournalStep
} from './workspace-edit-inverse'
import {
  capturePreimage,
  commitStep,
  hostPathOf,
  rollbackJournal
} from './workspace-edit-journal'

/** Host file primitives the journal drives; the real implementation stages
 * writes as temp+rename so each file lands atomically (#36 per-file commit). */
export type WorkspaceEditTransactionPorts = {
  readText(hostPath: string): Promise<string | null>
  exists(hostPath: string): Promise<boolean>
  writeAtomic(hostPath: string, content: string): Promise<void>
  createFile(hostPath: string): Promise<void>
  renamePath(oldPath: string, newPath: string): Promise<void>
  deletePath(hostPath: string, recursive?: boolean): Promise<void>
  /** Flushes/cancels pending editor autosaves for the affected paths (#23). */
  quiesceEditorSaves(hostPaths: readonly string[]): Promise<void>
  openDocumentFor(hostPath: string): {
    isDirty: boolean
    syncedText: string | null
    syncedVersion: number | null
  } | null
}

export type WorkspaceEditTransactionScope = WorkspaceEditScopeRef

/** Terminal state of the guarded pipeline; shared module so the flow and the
 * preview drawer both depend on the engine, not on each other. */
export type GuardedSemanticEditResult =
  | { kind: 'cancelled' }
  | { kind: 'outcome'; outcome: WorkspaceEditTransactionOutcome | null }

// ponytail: one global serial queue — semantic edits are rare user actions;
// per-path lock graphs can follow if concurrent edits ever contend.
let transactionQueue: Promise<unknown> = Promise.resolve()

export function runWorkspaceEditTransaction(args: {
  steps: readonly WorkspaceEditPlannedStep[]
  scope: WorkspaceEditTransactionScope
  operationHostId: ExecutionHostId
  ports: WorkspaceEditTransactionPorts
  now?: () => number
}): Promise<WorkspaceEditTransactionOutcome> {
  const run = (): Promise<WorkspaceEditTransactionOutcome> =>
    executeWorkspaceEditTransaction(args).catch(
      (error): WorkspaceEditTransactionOutcome => ({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        rolledBack: false,
        steps: [],
        recovery: {
          capability: WORKSPACE_EDIT_CAPABILITY,
          scopeId: args.scope.id,
          executionHostId: args.scope.executionHostId,
          createdAt: (args.now ?? Date.now)(),
          error: String(error instanceof Error ? error.message : error),
          entries: []
        }
      })
    )
  transactionQueue = transactionQueue.then(run, run)
  return transactionQueue as Promise<WorkspaceEditTransactionOutcome>
}

async function executeWorkspaceEditTransaction(args: {
  steps: readonly WorkspaceEditPlannedStep[]
  scope: WorkspaceEditTransactionScope
  operationHostId: ExecutionHostId
  ports: WorkspaceEditTransactionPorts
  now?: () => number
}): Promise<WorkspaceEditTransactionOutcome> {
  const { ports } = args
  const block = (target: {
    uri: string
    hostPath: string
    reason: WorkspaceEditBlockedTarget['reason']
    detail?: string
  }): WorkspaceEditTransactionOutcome => ({ status: 'blocked', blocks: [target] })

  // 1. Revalidate every target before any mutation (all-or-nothing).
  const { blocks: authBlocks } = authorizeWorkspaceEditTargets({
    scope: args.scope,
    operationHostId: args.operationHostId,
    targets: collectStepTargets(args.steps)
  })
  if (authBlocks.length > 0) {
    return { status: 'blocked', blocks: authBlocks }
  }
  for (const step of args.steps) {
    if (step.type === 'rename') {
      if (!(await ports.exists(step.oldHostPath))) {
        return block({ uri: step.oldUri, hostPath: step.oldHostPath, reason: 'missing-target' })
      }
      if (!step.overwrite && (await ports.exists(step.newHostPath))) {
        return block({ uri: step.newUri, hostPath: step.newHostPath, reason: 'existing-target' })
      }
      continue
    }
    if (step.type === 'create' && !step.overwrite && (await ports.exists(step.hostPath))) {
      return block({ uri: step.uri, hostPath: step.hostPath, reason: 'existing-target' })
    }
    if (step.type === 'delete' && !(await ports.exists(step.hostPath))) {
      return block({ uri: step.uri, hostPath: step.hostPath, reason: 'missing-target' })
    }
    if (step.type === 'write') {
      const open = ports.openDocumentFor(step.hostPath)
      if (open?.isDirty) {
        return block({ uri: step.uri, hostPath: step.hostPath, reason: 'dirty-editor' })
      }
      if (
        step.documentVersion !== null &&
        open?.syncedVersion != null &&
        step.documentVersion !== open.syncedVersion
      ) {
        return block({
          uri: step.uri,
          hostPath: step.hostPath,
          reason: 'stale-version',
          detail: `document version ${step.documentVersion} ≠ synced version ${open.syncedVersion}`
        })
      }
    }
  }

  // 2. Quiesce editor autosaves so no queued save races the preimage reads.
  await ports.quiesceEditorSaves(collectStepPaths(args.steps))

  // 3+4. Commit per file: capture the preimage immediately before each step so
  // later steps see earlier steps' postimages (undo chains rename then write).
  // A drifted base with an empty journal is still a clean block; otherwise the
  // journal rolls everything back (all-or-nothing).
  const journal: JournalStep[] = []
  for (const step of args.steps) {
    const captured = await capturePreimage(step, ports)
    if ('block' in captured) {
      if (journal.length === 0) {
        return block(captured.block)
      }
      return failedOutcome(args, journal, 'disk content differs from the planned base')
    }
    try {
      await commitStep(step, ports)
      journal.push({ ...captured.entry, status: 'committed' })
    } catch (error) {
      return failedOutcome(args, journal, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    status: 'committed',
    steps: journal.map((entry): WorkspaceEditStepOutcome => ({
      hostPath: hostPathOf(entry.step),
      type: entry.step.type,
      status: 'committed'
    })),
    undo: buildWorkspaceEditUndoEntry(args.scope, journal, (args.now ?? Date.now)())
  }
}

async function failedOutcome(
  args: {
    scope: WorkspaceEditTransactionScope
    ports: WorkspaceEditTransactionPorts
    now?: () => number
  },
  journal: JournalStep[],
  error: string
): Promise<WorkspaceEditTransactionOutcome> {
  const rolledBack = await rollbackJournal(journal, args.ports)
  const message = `${error}${rolledBack ? '' : ' (rollback incomplete — recovery artifact attached)'}`
  return {
    status: 'failed',
    error: message,
    rolledBack,
    steps: journal.map((done): WorkspaceEditStepOutcome => ({
      hostPath: hostPathOf(done.step),
      type: done.step.type,
      status: done.status
    })),
    recovery: {
      capability: WORKSPACE_EDIT_CAPABILITY,
      scopeId: args.scope.id,
      executionHostId: args.scope.executionHostId,
      createdAt: (args.now ?? Date.now)(),
      error: message,
      entries: rolledBack ? [] : buildWorkspaceEditRecoveryEntries(journal)
    }
  }
}

function collectStepTargets(
  steps: readonly WorkspaceEditPlannedStep[]
): { uri: string; hostPath: string }[] {
  return steps.flatMap((step): { uri: string; hostPath: string }[] =>
    step.type === 'rename'
      ? [
          { uri: step.oldUri, hostPath: step.oldHostPath },
          { uri: step.newUri, hostPath: step.newHostPath }
        ]
      : [{ uri: step.uri, hostPath: step.hostPath }]
  )
}

function collectStepPaths(steps: readonly WorkspaceEditPlannedStep[]): string[] {
  const paths = new Set<string>()
  for (const step of steps) {
    if (step.type === 'rename') {
      paths.add(step.oldHostPath)
      paths.add(step.newHostPath)
    } else {
      paths.add(step.hostPath)
    }
  }
  return [...paths]
}
