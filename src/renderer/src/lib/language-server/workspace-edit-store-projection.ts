import type { WorkspaceEditPlannedStep } from '../../../../shared/language-server-workspace-edit'
import type { OpenFile } from '@/store/slices/editor'
import { remapOpenEditorTabsForPathChange } from '@/lib/remap-open-editor-tabs-for-path-change'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../components/editor/editor-autosave'
import { recordSelfWrite } from '../../components/editor/editor-self-write-registry'

/** What the editor/store must learn about after a transaction commits. */
export type WorkspaceEditProjection = {
  /** Stamped before dispatching so our own writes never flag as conflicts. */
  selfWrites: { hostPath: string; content: string }[]
  /** Reload nudge for open tabs on the touched paths. */
  externalChanges: { worktreeId: string; relativePath: string }[]
  /** Open-editor retargeting for renames. */
  remaps: { fromPath: string; toPath: string }[]
}

/** Pure decision step so projection behavior is testable without a store. */
export function planWorkspaceEditProjection(args: {
  steps: readonly WorkspaceEditPlannedStep[]
  openFiles: readonly OpenFile[]
}): WorkspaceEditProjection {
  const contextByPath = new Map(
    args.openFiles.map((file) => [file.filePath, {
      worktreeId: file.worktreeId,
      relativePath: file.relativePath
    }])
  )
  const selfWrites: WorkspaceEditProjection['selfWrites'] = []
  const externalChanges: WorkspaceEditProjection['externalChanges'] = []
  const remaps: WorkspaceEditProjection['remaps'] = []
  const nudge = (hostPath: string): void => {
    const context = contextByPath.get(hostPath)
    if (context) {
      externalChanges.push(context)
    }
  }
  for (const step of args.steps) {
    if (step.type === 'rename') {
      remaps.push({ fromPath: step.oldHostPath, toPath: step.newHostPath })
      nudge(step.oldHostPath)
      nudge(step.newHostPath)
      continue
    }
    if (step.type === 'write') {
      selfWrites.push({ hostPath: step.hostPath, content: step.nextContent })
    }
    nudge(step.hostPath)
  }
  return { selfWrites, externalChanges, remaps }
}

/**
 * Model/store projection (#36): stamps self-writes, retargets renamed tabs,
 * and nudges open editors to reload — reusing the editor's external-change
 * machinery instead of duplicating content plumbing.
 */
export function projectCommittedWorkspaceEdit(args: {
  steps: readonly WorkspaceEditPlannedStep[]
  openFiles: readonly OpenFile[]
  worktreePathFor: (worktreeId: string) => string | null
  recordSelfWrite?: typeof recordSelfWrite
  remapOpenFiles?: (remap: { fromPath: string; toPath: string }) => void
  dispatch?: (target: EditorPathMutationTarget) => void
}): void {
  const projection = planWorkspaceEditProjection({ steps: args.steps, openFiles: args.openFiles })
  for (const selfWrite of projection.selfWrites) {
    ;(args.recordSelfWrite ?? recordSelfWrite)(selfWrite.hostPath, selfWrite.content)
  }
  for (const remap of projection.remaps) {
    if (args.remapOpenFiles) {
      args.remapOpenFiles(remap)
      continue
    }
    const owner = args.openFiles.find((open) => isPathInsideOrEqual(remap.fromPath, open.filePath))
    const worktreePath = owner ? args.worktreePathFor(owner.worktreeId) : null
    if (owner && worktreePath) {
      remapOpenEditorTabsForPathChange({
        fromPath: remap.fromPath,
        toPath: remap.toPath,
        worktreePath,
        worktreeId: owner.worktreeId
      })
    }
  }
  const dispatch =
    args.dispatch ??
    ((target: EditorPathMutationTarget): void => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, { detail: target })
      )
    })
  for (const change of projection.externalChanges) {
    const worktreePath = args.worktreePathFor(change.worktreeId)
    if (worktreePath) {
      dispatch({ worktreeId: change.worktreeId, worktreePath, relativePath: change.relativePath })
    }
  }
}
