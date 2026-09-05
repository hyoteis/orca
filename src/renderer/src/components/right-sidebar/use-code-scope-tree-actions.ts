import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { dirname, joinPath } from '@/lib/path'
import { extractIpcErrorMessage, renameFileOnDisk } from '@/lib/rename-file'
import { detectLanguage } from '@/lib/language-detect'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  addCodeIntelligenceMembers,
  findCodeIntelligenceScopeForWorkspace,
  removeCodeIntelligenceMembers,
  writeCodeIntelligenceScopeEdit
} from '@/lib/language-server/code-intelligence-scope-member-edit'
import { createRuntimePath, deleteRuntimePath } from '@/runtime/runtime-file-client'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
import { translate } from '@/i18n/i18n'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from './file-explorer-operation-owner'
import { formatFileExplorerPathsForClipboard } from './file-explorer-selection'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'
import {
  buildAddProjectFromFolderModalData,
  canShowAddAsProjectAction
} from './file-explorer-add-project-action'
import { useFileDeletion } from './useFileDeletion'
import { useFileDuplicate } from './useFileDuplicate'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import type { LazyDirectoryListing } from './use-lazy-directory-listing'

const isWindows = navigator.userAgent.includes('Windows')

type UseCodeScopeTreeActionsParams = {
  activeWorktreeId: string | null
  /** Host root that owns the listing route — effectiveWorktree.path for the session. */
  worktreePath: string | null
  connectionId: string | null
  activeRepo: Repo | undefined
  scopes: readonly CodeIntelligenceScope[]
  listing: LazyDirectoryListing
  openFile: (filePath: string, fileName: string) => void
}

/** Worktree-tree menu parity for the Code scopes member tree (#81): the same
 *  runtime file ops and dialogs, routed at the listing's owning workspace. */
export function useCodeScopeTreeActions({
  activeWorktreeId,
  worktreePath,
  connectionId,
  activeRepo,
  scopes,
  listing,
  openFile
}: UseCodeScopeTreeActionsParams) {
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const openModal = useAppStore((s) => s.openModal)
  const refreshDir = useCallback(
    (dirPath: string): Promise<void> => listing.refreshDir(dirPath),
    [listing]
  )
  const { deleteShortcutLabel, requestDelete } = useFileDeletion({
    activeWorktreeId,
    openFiles,
    closeFile,
    refreshDir,
    setSelectedPaths: () => {},
    isWindows
  })
  const duplicate = useFileDuplicate({ activeWorktreeId, worktreePath, refreshDir })

  const [inlineInput, setInlineInput] = useState<InlineInput | null>(null)
  const startNew = useCallback(
    (type: 'file' | 'folder', dir: string, depth: number): void => {
      // The worktree tree relies on its virtualizer to expand the parent; here
      // the lazy listing owns expansion, so seed it before inserting the row.
      if (!listing.expandedDirs.has(dir)) {
        listing.toggleDir(dir)
      }
      setInlineInput({
        parentPath: dir,
        type,
        depth,
        operationOwner: getFileExplorerOperationOwner(activeWorktreeId)
      })
    },
    [activeWorktreeId, listing]
  )
  const startRename = useCallback((node: TreeNode): void => {
    setInlineInput({
      parentPath: dirname(node.path),
      type: 'rename',
      depth: node.depth,
      existingName: node.name,
      existingPath: node.path,
      operationOwner: node.operationOwner
    })
  }, [])
  const dismissInlineInput = useCallback((): void => setInlineInput(null), [])

  const submitInlineInput = useCallback(
    (value: string): void => {
      if (!inlineInput || !value.trim() || !activeWorktreeId || !worktreePath) {
        setInlineInput(null)
        return
      }
      const name = value.trim()
      if (inlineInput.type === 'rename' && name === inlineInput.existingName) {
        setInlineInput(null)
        return
      }
      const run = async (): Promise<void> => {
        if (inlineInput.type === 'rename' && inlineInput.existingPath) {
          await renameFileOnDisk({
            oldPath: inlineInput.existingPath,
            newName: name,
            worktreeId: activeWorktreeId,
            worktreePath,
            operationOwner: inlineInput.operationOwner,
            refreshDir
          })
          return
        }
        const fullPath = joinPath(inlineInput.parentPath, name)
        try {
          const operationGuard = captureFileExplorerOperationGuard(
            activeWorktreeId,
            inlineInput.operationOwner
          )
          const operationRoute = operationGuard.route
          const fileContext = {
            settings: operationRoute.settings,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: operationRoute.connectionId,
            expectedExecutionHostId: operationRoute.expectedExecutionHostId,
            expectedSshTargetId: operationRoute.expectedSshTargetId,
            expectedSshConnectionGeneration: operationRoute.expectedSshConnectionGeneration
          }
          operationGuard.assertCurrent()
          const kind = inlineInput.type === 'folder' ? 'directory' : 'file'
          await createRuntimePath(fileContext, fullPath, kind)
          // Same undo contract as the worktree tree: folder create/delete pair stays reversible.
          commitFileExplorerOp({
            undo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              await deleteRuntimePath(
                {
                  ...fileContext,
                  settings: currentRoute.settings,
                  connectionId: currentRoute.connectionId
                },
                fullPath,
                true
              )
              await refreshDir(inlineInput.parentPath)
            },
            redo: async () => {
              const currentRoute = operationGuard.assertCurrent()
              await createRuntimePath(
                {
                  ...fileContext,
                  settings: currentRoute.settings,
                  connectionId: currentRoute.connectionId
                },
                fullPath,
                kind
              )
              await refreshDir(inlineInput.parentPath)
            }
          })
          await refreshDir(inlineInput.parentPath)
          if (inlineInput.type === 'file') {
            const runtimeEnvironmentId =
              fileContext.settings.activeRuntimeEnvironmentId?.trim() || null
            useAppStore.getState().openFile(
              {
                filePath: fullPath,
                relativePath: fullPath.slice(worktreePath.length + 1),
                worktreeId: activeWorktreeId,
                runtimeEnvironmentId: runtimeEnvironmentId ?? undefined,
                language: detectLanguage(name),
                mode: 'edit'
              },
              { suppressActiveRuntimeFallback: runtimeEnvironmentId === null }
            )
          }
        } catch (err) {
          await refreshDir(inlineInput.parentPath)
          toast.error(extractIpcErrorMessage(err, `Failed to create '${name}'.`))
        }
      }
      void run()
      setInlineInput(null)
    },
    [activeWorktreeId, inlineInput, refreshDir, worktreePath]
  )

  const copyPaths = useCallback((node: TreeNode, pathKind: 'absolute' | 'relative'): void => {
    void window.api.ui.writeClipboardText(formatFileExplorerPathsForClipboard([node], pathKind))
  }, [])
  const openInTerminal = useCallback(
    (node: TreeNode): void => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      createNewTerminalTab(activeWorktreeId, undefined, { startupCwd: node.path })
    },
    [activeWorktreeId]
  )
  const viewFile = useCallback(
    (node: TreeNode): void => {
      openFile(node.path, node.name)
    },
    [openFile]
  )
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)
  const findInFolder = useCallback(
    (node: TreeNode): void => {
      if (!node.isDirectory) {
        return
      }
      showRightSidebarSearch({ includePattern: folderRelativePathToIncludeGlob(node.relativePath) })
    },
    [showRightSidebarSearch]
  )
  const collapseFolder = useCallback(
    (node: TreeNode): void => {
      listing.toggleDir(node.path)
    },
    [listing]
  )
  const addFolderAsProject = useCallback(
    (node: TreeNode): void => {
      if (!activeRepo) {
        return
      }
      openModal(
        'confirm-add-project-from-folder',
        buildAddProjectFromFolderModalData(node, activeRepo)
      )
    },
    [activeRepo, openModal]
  )
  const canAddFolderAsProject = useCallback(
    (node: TreeNode): boolean => canShowAddAsProjectAction(node, activeRepo ?? null),
    [activeRepo]
  )
  const cppScope = scopes.find((scope) => scope.language === 'cpp') ?? null
  const toggleCodeIntelligenceMembers = useCallback(
    (paths: readonly string[], action: 'add' | 'remove'): void => {
      if (!activeRepo || !worktreePath) {
        return
      }
      const scope = findCodeIntelligenceScopeForWorkspace({
        settings: useAppStore.getState().settings,
        repoId: activeRepo.id,
        isFolder: isFolderRepo(activeRepo),
        executionHostId: getRepoExecutionHostId(activeRepo),
        language: 'cpp'
      })
      if (!scope) {
        return
      }
      // Menu paths are absolute; scopes store workspace-relative member paths.
      const relativePaths = paths
        .map((path) => (path.startsWith(worktreePath) ? path.slice(worktreePath.length + 1) : null))
        .filter((relativePath): relativePath is string => Boolean(relativePath))
      const next =
        action === 'add'
          ? addCodeIntelligenceMembers(scope, relativePaths)
          : removeCodeIntelligenceMembers(scope, relativePaths)
      if (next === null) {
        toast.info(
          translate('settings.codeIntelligence.cannotRemoveLastFolder', 'Keep at least one folder')
        )
        return
      }
      if (next !== scope) {
        void writeCodeIntelligenceScopeEdit(next)
      }
    },
    [activeRepo, worktreePath]
  )

  return {
    activeWorktreeId,
    inlineInput,
    startNew,
    startRename,
    dismissInlineInput,
    submitInlineInput,
    copyPaths,
    openInTerminal,
    viewFile,
    findInFolder,
    collapseFolder,
    duplicate,
    requestDelete,
    deleteShortcutLabel,
    addFolderAsProject,
    canAddFolderAsProject,
    toggleCodeIntelligenceMembers,
    codeIntelligenceScope: cppScope,
    connectionId
  }
}

export type CodeScopeTreeActions = ReturnType<typeof useCodeScopeTreeActions>
