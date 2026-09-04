import type {
  WorkspaceEditTransactionOutcome,
  WorkspaceEditUndoEntry
} from '../../../../shared/language-server-workspace-edit'
import { runWorkspaceEditTransaction } from './workspace-edit-transaction'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'

const MAX_UNDO_ENTRIES = 20

/** Session-scoped global undo (#20): inverse entries live only for this
 * renderer session and never persist. */
export class WorkspaceEditUndoStack {
  private readonly entries: WorkspaceEditUndoEntry[] = []
  constructor(private readonly capacity: number = MAX_UNDO_ENTRIES) {}
  push(entry: WorkspaceEditUndoEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.capacity) {
      this.entries.shift()
    }
  }
  pop(): WorkspaceEditUndoEntry | null {
    return this.entries.pop() ?? null
  }
  get latest(): WorkspaceEditUndoEntry | null {
    return this.entries.at(-1) ?? null
  }
  get size(): number {
    return this.entries.length
  }
}

let undoStackSingleton: WorkspaceEditUndoStack | null = null

export function getWorkspaceEditUndoStack(): WorkspaceEditUndoStack {
  undoStackSingleton ??= new WorkspaceEditUndoStack()
  return undoStackSingleton
}

/** Pops the latest entry and runs its inverse; a blocked/failed undo keeps the
 * entry for retry, a committed one pushes its own inverse back (redo). */
export async function undoLatestWorkspaceEdit(args: {
  ports: WorkspaceEditTransactionPorts
  stack?: WorkspaceEditUndoStack
}): Promise<WorkspaceEditTransactionOutcome | null> {
  const stack = args.stack ?? getWorkspaceEditUndoStack()
  const entry = stack.pop()
  if (!entry) {
    return null
  }
  const outcome = await runWorkspaceEditTransaction({
    steps: entry.steps,
    scope: entry.scope,
    operationHostId: entry.scope.executionHostId,
    ports: args.ports
  })
  if (outcome.status === 'committed') {
    stack.push(outcome.undo)
  } else {
    stack.push(entry)
  }
  return outcome
}
