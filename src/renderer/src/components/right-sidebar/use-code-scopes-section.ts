import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useWorktreeMap } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { writeCodeIntelligenceScopeEdit } from '@/lib/language-server/code-intelligence-scope-member-edit'
import type { DirEntry, Worktree } from '../../../../shared/types'
import {
  getExecutionHostLabel,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { getFolderWorkspaceExecutionHostId } from '../../../../shared/folder-workspace-repo-link'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getStatusBarCodeIntelligenceScopes,
  findSessionLinkedFolderRepo
} from '../status-bar/code-intelligence-status-scopes'
import { buildAddProjectFromFolderModalData } from './file-explorer-add-project-action'
import {
  buildCodePanelMemberRows,
  getCodePanelKeptEmptyLanguages,
  removeCodePanelMemberRow,
  type CodePanelMemberRow
} from './code-panel-member-tree'
import { readFileExplorerDirectory } from './file-explorer-directory-listing'
import { openCodePanelFile } from './code-panel-open-file'
import { useLazyDirectoryListing } from './use-lazy-directory-listing'
import { useCodeScopeTreeActions, type CodeScopeTreeActions } from './use-code-scope-tree-actions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export type CodeScopeTreeContext = {
  actions: CodeScopeTreeActions
  /** Session host root used for relative paths / find-in-folder. */
  worktreePath: string | null
  supportsFolderDownload: boolean
  runtimeDownloadContext: RuntimeFileOperationArgs | null
  canOpenInOrcaBrowser: (path: string) => boolean
}

export type CodePanelDirectoryLister = (dirPath: string) => Promise<DirEntry[]>

export function useCodeScopesSection({
  listDirectory
}: {
  listDirectory?: CodePanelDirectoryLister
} = {}) {
  const settings = useAppStore((s) => s.settings)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const openModal = useAppStore((s) => s.openModal)
  const worktreeMap = useWorktreeMap()

  const activeWorktree = activeWorktreeId ? (worktreeMap.get(activeWorktreeId) ?? null) : null
  const folderWorkspace = useMemo(() => {
    const parsed = activeWorktreeId ? parseWorkspaceKey(activeWorktreeId) : null
    return parsed?.type === 'folder'
      ? (folderWorkspaces.find(
          (candidate) => folderWorkspaceKey(candidate.id) === activeWorktreeId
        ) ?? null)
      : null
  }, [activeWorktreeId, folderWorkspaces])
  // #72 variant A: folder sessions read/write the same-path folder repo's scopes.
  const linkedFolderRepo = useMemo(
    () => findSessionLinkedFolderRepo({ activeWorktreeId, folderWorkspaces, repos }),
    [activeWorktreeId, folderWorkspaces, repos]
  )
  const bridged = folderWorkspace !== null && linkedFolderRepo !== null
  // Folder workspaces unify through the same Worktree host precedence as the sidebar.
  const effectiveWorktree: Worktree | null =
    activeWorktree ?? (folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : null)
  const activeRepo = effectiveWorktree
    ? (repos.find((repo) => repo.id === effectiveWorktree.repoId) ?? undefined)
    : undefined
  const executionHostId = effectiveWorktree
    ? getWorktreeExecutionHostId(effectiveWorktree, activeRepo)
    : null
  const scopes = useMemo(
    () =>
      getStatusBarCodeIntelligenceScopes({
        settings,
        activeWorktreeId,
        executionHostId,
        folderWorkspaces,
        repos
      }),
    [settings, activeWorktreeId, executionHostId, folderWorkspaces, repos]
  )
  const rows = useMemo(() => buildCodePanelMemberRows(scopes), [scopes])
  const keptEmptyLanguages = useMemo(() => getCodePanelKeptEmptyLanguages(scopes), [scopes])
  // Configure routes to the existing C++ setup dialog, which pre-checks the
  // scope's current members itself (single source of truth, #63 decision 4).
  const configureRepoId = useMemo(() => {
    const cppScope = scopes.find((scope) => scope.language === 'cpp')
    const parsed = cppScope ? parseWorkspaceKey(cppScope.workspaceKey) : null
    return parsed ? (parsed.type === 'folder' ? parsed.folderWorkspaceId : parsed.worktreeId) : null
  }, [scopes])

  const seedSourceRepo = activeRepo ?? linkedFolderRepo

  const openAsWorkspace = (row: CodePanelMemberRow): void => {
    if (!seedSourceRepo) {
      return
    }
    openModal(
      'confirm-add-project-from-folder',
      buildAddProjectFromFolderModalData({ path: row.directory }, seedSourceRepo)
    )
  }
  const addWorkspaceFolderAsProject = (): void => {
    if (!folderWorkspace) {
      return
    }
    const host = parseExecutionHostId(getFolderWorkspaceExecutionHostId(folderWorkspace))
    openModal(
      'confirm-add-project-from-folder',
      host?.kind === 'ssh'
        ? { folderPath: folderWorkspace.folderPath, connectionId: host.targetId }
        : {
            folderPath: folderWorkspace.folderPath,
            runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
          }
    )
  }
  const openFile = (filePath: string, fileName: string): void => {
    if (!activeWorktreeId || !effectiveWorktree) {
      return
    }
    openCodePanelFile({
      filePath,
      fileName,
      activeWorktreeId,
      workspaceRootPath: effectiveWorktree.path
    })
  }
  const reveal = (row: CodePanelMemberRow): void => {
    if (isLocalPathOpenBlocked(settings, { connectionId: seedSourceRepo?.connectionId ?? null })) {
      showLocalPathOpenBlockedToast()
      return
    }
    window.api.shell.openPath(row.directory)
  }
  const remove = (row: CodePanelMemberRow): void => {
    void Promise.all(
      removeCodePanelMemberRow(scopes, row.path).map((next) => writeCodeIntelligenceScopeEdit(next))
    )
  }

  const defaultListDirectory = useCallback(
    async (dirPath: string): Promise<DirEntry[]> => {
      if (!activeWorktreeId || !effectiveWorktree) {
        throw new Error(
          translate(
            'auto.components.rightSidebar.CodePanel.noWorkspace',
            'No active workspace owns this folder'
          )
        )
      }
      return readFileExplorerDirectory(activeWorktreeId, effectiveWorktree.path, dirPath).then(
        (listing) => listing.entries
      )
    },
    [activeWorktreeId, effectiveWorktree]
  )
  const list = listDirectory ?? defaultListDirectory
  const listing = useLazyDirectoryListing(list)

  // Worktree-tree menu parity (#81): same ops/dialogs, routed at the session's host.
  const supportsFolderDownload = useAppStore((s) => {
    const repoConnectionId = activeRepo?.connectionId
    return repoConnectionId
      ? s.sshConnectionStates.get(repoConnectionId)?.supportsFolderDownload === true
      : false
  })
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, activeWorktreeId)
  )
  const runtimeDownloadContext = useMemo(
    () =>
      activeRuntimeEnvironmentId && activeWorktreeId && effectiveWorktree
        ? {
            settings: { activeRuntimeEnvironmentId: activeRuntimeEnvironmentId },
            worktreeId: activeWorktreeId,
            worktreePath: effectiveWorktree.path,
            connectionId: activeRepo?.connectionId ?? undefined
          }
        : null,
    [activeRepo?.connectionId, activeRuntimeEnvironmentId, activeWorktreeId, effectiveWorktree]
  )
  const treeActions = useCodeScopeTreeActions({
    activeWorktreeId,
    worktreePath: effectiveWorktree?.path ?? null,
    connectionId: seedSourceRepo?.connectionId ?? null,
    activeRepo,
    scopes,
    listing,
    openFile
  })
  const canOpenInOrcaBrowser = useWorkspaceFileBrowserActionPredicate(activeWorktreeId)
  const tree: CodeScopeTreeContext = {
    actions: treeActions,
    worktreePath: effectiveWorktree?.path ?? null,
    supportsFolderDownload,
    runtimeDownloadContext,
    canOpenInOrcaBrowser
  }

  return {
    scopes,
    rows,
    keptEmptyLanguages,
    configureRepoId,
    folderWorkspace,
    linkedFolderRepo,
    bridged,
    hostLabel: executionHostId ? getExecutionHostLabel(executionHostId) : null,
    listing,
    tree,
    openAsWorkspace,
    addWorkspaceFolderAsProject,
    openFile,
    reveal,
    remove
  }
}
