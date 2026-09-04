import { basename, dirname, joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  createRuntimePath,
  deleteRuntimePath,
  readRuntimeFileContent,
  renameRuntimePath,
  runtimePathExists,
  statRuntimePath,
  writeRuntimeFile
} from '@/runtime/runtime-file-client'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { requestEditorSaveQuiesce } from '../../components/editor/editor-autosave'
import type { WorkspaceEditTransactionPorts } from './workspace-edit-transaction'

/** The host that will physically execute the file operations. Runtime
 * environments route through the active environment; SSH through the
 * connection; everything else is the local host. */
export function resolveWorkspaceEditOperationHostId(
  context: RuntimeFileOperationArgs
): ExecutionHostId {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'environment') {
    return toRuntimeExecutionHostId(target.environmentId)
  }
  return (
    context.expectedExecutionHostId ??
    (context.connectionId ? toSshExecutionHostId(context.connectionId) : 'local')
  )
}

/** Same-directory staging file so the commit rename stays on one filesystem. */
export function workspaceEditStagingPath(hostPath: string, sequence: number): string {
  return joinPath(dirname(hostPath), `${basename(hostPath)}.orca-we${sequence}.tmp`)
}

/**
 * Editor-backed ports (#36). `context.worktreePath` must be the scope's
 * workspace root: remote Runtime hosts resolve every mutation relative to it.
 */
export function createWorkspaceEditEditorPorts(args: {
  context: RuntimeFileOperationArgs
  /** Synced LSP document versions; #37 wires the session's registry. */
  syncedDocumentFor?: (hostPath: string) => number | null
  openFiles?: () => readonly OpenFile[]
}): WorkspaceEditTransactionPorts {
  const { context } = args
  let stagingSequence = 0
  const openFiles = args.openFiles ?? ((): readonly OpenFile[] => [])
  return {
    readText: async (hostPath) => {
      if (!(await runtimePathExists(context, hostPath))) {
        return null
      }
      const stats = await statRuntimePath(context, hostPath)
      if (stats.isDirectory) {
        throw new Error(`Workspace edit target is a directory: ${hostPath}`)
      }
      const relative = relativePathInsideRoot(context.worktreePath ?? '', hostPath)
      const content = await readRuntimeFileContent({
        settings: context.settings,
        filePath: hostPath,
        relativePath: !relative || relative === '.' ? undefined : relative,
        worktreeId: context.worktreeId ?? undefined,
        connectionId: context.connectionId,
        expectedExternalSshTargetId: context.expectedExternalSshTargetId
      })
      if (content.isBinary) {
        throw new Error(`Workspace edit target is binary: ${hostPath}`)
      }
      return content.content
    },
    exists: (hostPath) => runtimePathExists(context, hostPath),
    writeAtomic: async (hostPath, content) => {
      // Per-file atomic commit: stage beside the target, then rename over it.
      // The replace-rename is overwrite-flagged because plain fs:rename is the
      // no-clobber contract used by explorer moves.
      stagingSequence += 1
      const staged = workspaceEditStagingPath(hostPath, stagingSequence)
      try {
        await writeRuntimeFile(context, staged, content)
        await renameRuntimePath(context, staged, hostPath, { overwrite: true })
      } catch (error) {
        void deleteRuntimePath(context, staged).catch(() => undefined)
        throw error
      }
    },
    createFile: (hostPath) => createRuntimePath(context, hostPath, 'file'),
    renamePath: (oldPath, newPath) => renameRuntimePath(context, oldPath, newPath),
    deletePath: (hostPath, recursive) => deleteRuntimePath(context, hostPath, recursive),
    quiesceEditorSaves: async (hostPaths) => {
      const files = openFiles()
      await Promise.all(
        hostPaths.flatMap((hostPath) => {
          const file = files.find(
            (openFile) =>
              openFile.filePath === hostPath &&
              (openFile.mode === 'edit' || openFile.mode === 'markdown-preview')
          )
          return file ? [requestEditorSaveQuiesce({ fileId: file.id })] : []
        })
      )
    },
    openDocumentFor: (hostPath) => {
      const file = openFiles().find((openFile) => openFile.filePath === hostPath)
      if (!file || file.readOnly) {
        return null
      }
      return {
        isDirty: file.isDirty,
        syncedText: null,
        syncedVersion: args.syncedDocumentFor?.(hostPath) ?? null
      }
    }
  }
}
