import type { ExecutionHostId } from './execution-host'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeMember
} from './code-intelligence-scope'

/** Scope slice a transaction runs under; members stay readonly. */
export type WorkspaceEditScopeRef = Pick<
  CodeIntelligenceScope,
  'id' | 'executionHostId' | 'workspaceRoot'
> & { members: readonly CodeIntelligenceScopeMember[] }

/**
 * Guarded workspace-edit contract (#20/#36): every mutating semantic result —
 * rename, code action, server-initiated applyEdit — runs through an authorized,
 * version-checked, all-or-nothing transaction journal before touching the
 * execution host's files. The version is negotiated separately from reading
 * capabilities so mixed Client/Host versions never let a server mutate through
 * a client that lacks the guard.
 */
export const WORKSPACE_EDIT_CAPABILITY = 'language-server.workspace-edit.v1'

/** Resource operations v1 supports; advertised to servers in initialize. */
export const WORKSPACE_EDIT_RESOURCE_OPERATIONS = ['create', 'rename', 'delete'] as const

/** v1 failure handling advertised to servers: abort on first failure (#20). */
export const WORKSPACE_EDIT_FAILURE_HANDLING = 'abort' as const

export type WorkspaceEditBlockReason =
  | 'out-of-scope' // path outside every consented scope member
  | 'host-mismatch' // operation host ≠ scope execution host
  | 'non-file-uri'
  | 'stale-version' // synced document version moved since the edit was computed
  | 'dirty-editor' // open editor tab holds an unsaved draft
  | 'external-change' // disk signature ≠ the captured base
  | 'existing-target' // create (or non-overwrite rename) destination exists
  | 'missing-target' // edit/rename/delete of an absent path
  | 'edit-application' // TextEdit positions invalid against the base text
  | 'unsupported-target' // v1 guards file targets only (directories)

export type WorkspaceEditBlockedTarget = {
  uri: string
  hostPath: string
  reason: WorkspaceEditBlockReason
  detail?: string
}

/** One atomic per-file operation the journal executes; ordered. */
export type WorkspaceEditPlannedStep =
  | {
      type: 'write'
      uri: string
      hostPath: string
      /** Base the edits were applied to; commit verifies the disk signature against
       * it. null = the target must be absent (undo recreates deleted files). */
      baseContent: string | null
      baseSignature: string
      nextContent: string
      /** Synced document version at plan time; re-checked at commit. */
      documentVersion: number | null
    }
  | {
      type: 'create'
      uri: string
      hostPath: string
      /** true = an existing file is truncated (preimage kept for rollback). */
      overwrite: boolean
    }
  | {
      type: 'rename'
      oldUri: string
      newUri: string
      oldHostPath: string
      newHostPath: string
      overwrite: boolean
    }
  | {
      type: 'delete'
      uri: string
      hostPath: string
      recursive?: boolean
    }

export type WorkspaceEditStepOutcome = {
  hostPath: string
  type: WorkspaceEditPlannedStep['type']
  status: 'committed' | 'rolled-back'
}

/** Restores the pre-transaction disk state when a rollback did not finish.
 * Applied in order; rename moves content from `fromPath` back to `toPath`. */
export type WorkspaceEditRecoveryEntry =
  | { hostPath: string; kind: 'content'; content: string }
  | { hostPath: string; kind: 'delete' }
  | { kind: 'rename'; fromPath: string; toPath: string }

export type WorkspaceEditRecoveryArtifact = {
  capability: typeof WORKSPACE_EDIT_CAPABILITY
  scopeId: string
  executionHostId: ExecutionHostId
  createdAt: number
  error: string
  entries: WorkspaceEditRecoveryEntry[]
}

/** Session-scoped inverse of one committed transaction (#20 global undo). */
export type WorkspaceEditUndoEntry = {
  scope: WorkspaceEditScopeRef
  createdAt: number
  /** Reverse-ordered steps with bases pinned to the committed postimages. */
  steps: WorkspaceEditPlannedStep[]
}

export type WorkspaceEditTransactionOutcome =
  | { status: 'committed'; steps: WorkspaceEditStepOutcome[]; undo: WorkspaceEditUndoEntry }
  | { status: 'blocked'; blocks: WorkspaceEditBlockedTarget[] }
  | {
      status: 'failed'
      error: string
      /** true = every committed step was restored; false = recovery carries the rest. */
      rolledBack: boolean
      steps: WorkspaceEditStepOutcome[]
      recovery: WorkspaceEditRecoveryArtifact
    }

/** True when the outcome leaves zero durable changes on the host. */
export function isWorkspaceEditOutcomeClean(
  outcome: WorkspaceEditTransactionOutcome
): boolean {
  return outcome.status !== 'failed' || outcome.rolledBack
}
