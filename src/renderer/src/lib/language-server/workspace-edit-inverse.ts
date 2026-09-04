import type {
  WorkspaceEditPlannedStep,
  WorkspaceEditRecoveryEntry,
  WorkspaceEditScopeRef,
  WorkspaceEditUndoEntry
} from '../../../../shared/language-server-workspace-edit'
import { getDiskBaselineSignature } from '../../components/editor/diff-content-signature'

/** Disk state a step found before it ran; the rollback + undo source of truth. */
export type WorkspaceEditPreimage =
  | { kind: 'absent' }
  | { kind: 'content'; content: string }

export type JournalStep = {
  step: WorkspaceEditPlannedStep
  preimage: WorkspaceEditPreimage
  /** Destination content an overwrite rename destroyed; restored after the move-back. */
  renameDestinationPreimage?: WorkspaceEditPreimage
  status: 'committed' | 'rolled-back'
}

/** Reverse-ordered steps whose bases are pinned to the committed postimages —
 * running them through the engine is the session-scoped undo (#20). */
export function buildWorkspaceEditUndoEntry(
  scope: WorkspaceEditScopeRef,
  journal: readonly JournalStep[],
  now: number
): WorkspaceEditUndoEntry {
  const steps: WorkspaceEditPlannedStep[] = []
  for (const entry of journal.toReversed()) {
    const { step } = entry
    if (step.type === 'write') {
      // A null base means the step recreated a missing file; its inverse removes it again.
      if (step.baseContent === null) {
        steps.push({ type: 'delete', uri: step.uri, hostPath: step.hostPath })
        continue
      }
      steps.push({
        type: 'write',
        uri: step.uri,
        hostPath: step.hostPath,
        baseContent: step.nextContent,
        baseSignature: getDiskBaselineSignature(step.nextContent),
        nextContent: step.baseContent,
        documentVersion: null
      })
      continue
    }
    if (step.type === 'create') {
      if (entry.preimage.kind === 'content') {
        steps.push({
          type: 'write',
          uri: step.uri,
          hostPath: step.hostPath,
          baseContent: '',
          baseSignature: getDiskBaselineSignature(''),
          nextContent: entry.preimage.content,
          documentVersion: null
        })
      } else {
        steps.push({ type: 'delete', uri: step.uri, hostPath: step.hostPath })
      }
      continue
    }
    if (step.type === 'rename') {
      steps.push({
        type: 'rename',
        oldUri: step.newUri,
        newUri: step.oldUri,
        oldHostPath: step.newHostPath,
        newHostPath: step.oldHostPath,
        overwrite: false
      })
      if (entry.renameDestinationPreimage?.kind === 'content') {
        steps.push({
          type: 'write',
          uri: step.newUri,
          hostPath: step.newHostPath,
          baseContent: null,
          baseSignature: '',
          nextContent: entry.renameDestinationPreimage.content,
          documentVersion: null
        })
      }
      continue
    }
    steps.push({
      type: 'write',
      uri: step.uri,
      hostPath: step.hostPath,
      baseContent: null,
      baseSignature: '',
      nextContent: entry.preimage.kind === 'content' ? entry.preimage.content : '',
      documentVersion: null
    })
  }
  return { scope: { ...scope }, createdAt: now, steps }
}

/** Entries restoring whatever a failed rollback could not. */
export function buildWorkspaceEditRecoveryEntries(
  journal: readonly JournalStep[]
): WorkspaceEditRecoveryEntry[] {
  const entries: WorkspaceEditRecoveryEntry[] = []
  const unrestored = journal.filter((entry) => entry.status === 'committed')
  for (const entry of unrestored.toReversed()) {
    const { step, preimage } = entry
    if (step.type === 'rename') {
      entries.push({ kind: 'rename', fromPath: step.newHostPath, toPath: step.oldHostPath })
      if (entry.renameDestinationPreimage?.kind === 'content') {
        entries.push({
          hostPath: step.newHostPath,
          kind: 'content',
          content: entry.renameDestinationPreimage.content
        })
      }
      continue
    }
    // write/create/delete share one restore shape: content back, else absence.
    entries.push(
      preimage.kind === 'content'
        ? { hostPath: step.hostPath, kind: 'content', content: preimage.content }
        : { hostPath: step.hostPath, kind: 'delete' }
    )
  }
  return entries
}
