/* eslint-disable max-lines -- Why: FileExplorer coordinates tree data, selection, drag/drop, and virtual rows; splitting it during this merge would obscure the interaction invariants. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { basename, dirname } from '@/lib/path'
import { toast } from 'sonner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo, isGitRepoKind } from '../../../../shared/repo-kind'
import {
  addCodeIntelligenceMembers,
  findCodeIntelligenceScopeForWorkspace,
  removeCodeIntelligenceMembers,
  writeCodeIntelligenceScopeEdit
} from '@/lib/language-server/code-intelligence-scope-member-edit'
import { folderRelativePathToIncludeGlob } from './file-search-include-pattern'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  getVisibleFileExplorerWorktreePath,
  shouldResetFileExplorerForVisibleWorktree
} from './file-explorer-reset'
import { FileExplorerBackgroundMenu } from './FileExplorerBackgroundMenu'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { splitPathSegments } from './path-tree'
import { buildFolderStatusMap, buildStatusMap } from './status-display'
import { useFileDeletion } from './useFileDeletion'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerReveal } from './useFileExplorerReveal'
import { useFileExplorerInlineInput } from './useFileExplorerInlineInput'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { useFileDuplicate } from './useFileDuplicate'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'
import { useFileExplorerImport } from './useFileExplorerImport'
import { useFileExplorerManualRefresh } from './useFileExplorerManualRefresh'
import { useFileExplorerTree } from './useFileExplorerTree'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { useFileExplorerWatch } from './useFileExplorerWatch'
import {
  buildAddProjectFromFolderModalData,
  canShowAddAsProjectAction
} from './file-explorer-add-project-action'
import { isRenameHotspotTarget, resolveDirToggleTiming } from './file-explorer-dir-toggle-timing'
import type { TreeNode } from './file-explorer-types'
import { OpenEditorsSection } from './OpenEditorsSection'
import { CodeScopesSection } from './CodeScopesSection'
import { useCodeScopesSection } from './use-code-scopes-section'
import { findSessionLinkedFolderRepo } from '../status-bar/code-intelligence-status-scopes'
import { useFileExplorerSelection } from './useFileExplorerSelection'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { translate } from '@/i18n/i18n'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/components/tab-bar/SortableTab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { createNewTerminalTab } from '@/components/terminal/terminal-tab-create'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import { WorktreeSection } from './WorktreeSection'

function FileExplorerFiles(): React.JSX.Element {
  const showRightSidebarSearch = useAppStore((s) => s.showRightSidebarSearch)
  // Owns the accordion: a collapsed Worktree frees panel height for the sections above.
  const [worktreeSectionCollapsed, setWorktreeSectionCollapsed] = useState(false)
  const toggleWorktreeSection = useCallback(() => {
    setWorktreeSectionCollapsed((value) => !value)
  }, [])
  // ponytail: collapse state is session-local; thread it through persisted
  // per-worktree UI settings if it must survive restarts.
  const [openEditorsCollapsed, setOpenEditorsCollapsed] = useState(false)
  const toggleOpenEditorsSection = useCallback(() => {
    setOpenEditorsCollapsed((value) => !value)
  }, [])
  const [codeScopesCollapsed, setCodeScopesCollapsed] = useState(false)
  const toggleCodeScopesSection = useCallback(() => {
    setCodeScopesCollapsed((value) => !value)
  }, [])
  // Code scopes drive the C++ member-tree decoration and find-in-folder seeding.
  const { scopes: codeScopes } = useCodeScopesSection()

  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const canOpenWorkspaceFileBrowserForPath =
    useWorkspaceFileBrowserActionPredicate(activeWorktreeId)
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const supportsFolderDownload = useAppStore((s) => {
    const connectionId = activeRepo?.connectionId
    return connectionId
      ? s.sshConnectionStates.get(connectionId)?.supportsFolderDownload === true
      : false
  })
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, activeWorktreeId)
  )
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const expandedDirs = useAppStore((s) => s.expandedDirs)
  const collapseAllDirs = useAppStore((s) => s.collapseAllDirs)
  const collapseDirSubtree = useAppStore((s) => s.collapseDirSubtree)
  const toggleDir = useAppStore((s) => s.toggleDir)
  const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const openFile = useAppStore((s) => s.openFile)
  const makePreviewFilePermanent = useAppStore((s) => s.makePreviewFilePermanent)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const openModal = useAppStore((s) => s.openModal)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const showDotfiles = useAppStore((s) =>
    activeWorktreeId ? (s.showDotfilesByWorktree[activeWorktreeId] ?? true) : true
  )
  const toggleShowDotfilesForWorktree = useAppStore((s) => s.toggleShowDotfilesForWorktree)

  const worktreePath = activeWorktree?.path ?? null
  const runtimeDownloadContext = useMemo(
    () =>
      activeRuntimeEnvironmentId && activeWorktreeId && worktreePath
        ? {
            settings: { activeRuntimeEnvironmentId },
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: activeRepo?.connectionId ?? undefined
          }
        : null,
    [activeRepo?.connectionId, activeRuntimeEnvironmentId, activeWorktreeId, worktreePath]
  )
  const visibleFilesWorktreePath = getVisibleFileExplorerWorktreePath({
    rightSidebarOpen,
    worktreePath
  })
  const repoName = activeRepo?.displayName ?? (worktreePath ? basename(worktreePath) : '')
  const activeRepoSupportsGit = activeRepo ? isGitRepoKind(activeRepo) : false

  const expanded = useMemo(
    () =>
      activeWorktreeId ? (expandedDirs[activeWorktreeId] ?? new Set<string>()) : new Set<string>(),
    [activeWorktreeId, expandedDirs]
  )

  const {
    dirCache,
    setDirCache,
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    isDirStale,
    resetAndLoad
  } = useFileExplorerTree(worktreePath, expanded, activeWorktreeId)
  // Freed height goes to the LAST expanded section only, so earlier sections stack
  // at their content height and the next section starts where the previous one ends
  // instead of at a fixed panel position.
  const codeScopesFills = worktreeSectionCollapsed && !codeScopesCollapsed
  const openEditorsFills =
    worktreeSectionCollapsed && codeScopesCollapsed && !openEditorsCollapsed
  const {
    rowProjection,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    toggleGitIgnoredFiles
  } = useFileExplorerVisibleRowProjection(
    activeWorktreeId,
    visibleFilesWorktreePath,
    dirCache,
    expanded,
    activeRepoSupportsGit,
    showDotfiles
  )
  const visibleRowCount = rowProjection.getVisibleCount()
  const manualRefresh = useFileExplorerManualRefresh(refreshTree)
  const canCollapseAll = expanded.size > 0
  const handleCollapseAll = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    collapseAllDirs(activeWorktreeId)
  }, [activeWorktreeId, collapseAllDirs])
  const handleToggleDotfiles = useCallback(() => {
    if (activeWorktreeId) {
      toggleShowDotfilesForWorktree(activeWorktreeId)
    }
  }, [activeWorktreeId, toggleShowDotfilesForWorktree])
  const handleExplorerBackgroundContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-slot="context-menu-trigger"]')) {
        return
      }
      event.preventDefault()
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
      setBgMenuPoint({ x: event.clientX, y: event.clientY })
      setBgMenuOpen(true)
    },
    []
  )

  const [flashingPath, setFlashingPath] = useState<string | null>(null)
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Includes Radix scroll viewport + scrollbar (scrollbar is not a child of the viewport). */
  const explorerShellRef = useRef<HTMLDivElement | null>(null)
  const flashTimeoutRef = useRef<number | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const isWindows = useMemo(() => navigator.userAgent.includes('Windows'), [])
  const {
    selectedPath,
    selectedPaths,
    setSingleSelectedPath,
    setSelectedPaths,
    resetSelection,
    selectRowWithModifiers,
    moveSelection,
    preserveSelectionForContextMenu,
    copyPathsForNode
  } = useFileExplorerSelection(rowProjection, isMac)

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const statusByRelativePath = useMemo(() => buildStatusMap(entries), [entries])
  const folderStatusByRelativePath = useMemo(() => buildFolderStatusMap(entries), [entries])

  const { deleteShortcutLabel, requestDelete, requestDeleteAll } = useFileDeletion({
    activeWorktreeId,
    openFiles,
    closeFile,
    refreshDir,
    setSelectedPaths,
    isWindows
  })

  const {
    handleMoveDrop,
    handleDragExpandDir,
    dropTargetDir,
    setDropTargetDir,
    dragSourcePath,
    setDragSourcePath,
    isRootDragOver,
    isNativeDragOver,
    nativeDropTargetDir,
    setNativeDropTargetDir,
    handleNativeDragExpandDir,
    stopDragEdgeScroll,
    rootDragHandlers,
    clearNativeDragState
  } = useFileExplorerDragDrop({
    worktreePath,
    activeWorktreeId,
    expanded,
    toggleDir,
    refreshDir,
    scrollRef,
    getOperationOwnerForPath: (path) => rowProjection.getRowByPath(path)?.operationOwner
  })

  const lastResetWorktreePathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    // Why: the sidebar remains mounted while closed to preserve caches, but
    // loading the hidden tree would probe every clicked workspace on macOS.
    if (
      !shouldResetFileExplorerForVisibleWorktree(
        lastResetWorktreePathRef.current,
        visibleFilesWorktreePath
      )
    ) {
      return
    }
    lastResetWorktreePathRef.current = visibleFilesWorktreePath
    resetSelection()
    resetAndLoad()
    clearFileExplorerUndoHistory()
  }, [visibleFilesWorktreePath, resetSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Why: on app startup the file explorer loads before SSH providers are
  // registered, so readDir fails for remote worktrees. When the SSH
  // connection is later established, sshConnectedGeneration bumps and this
  // effect retries the load. Only retries when there was a prior error to
  // avoid redundant reloads for local worktrees.
  const sshGenRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleFilesWorktreePath && rootError) {
        resetAndLoad()
      }
    }
  }, [sshConnectedGeneration, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    for (const dirPath of expanded) {
      // Why: a full refresh (watcher overflow) re-reads only root and the dirs expanded at the time,
      // so a listing cached while collapsed is unverified — re-read it here instead of trusting it.
      const decision = decideExpandedDirLoad(dirCache[dirPath], isDirStale(dirPath))
      if (decision === 'skip') {
        continue
      }
      const depth = splitPathSegments(dirPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
      void loadDir(dirPath, depth, decision === 'reload' ? { force: true } : undefined)
    }
  }, [expanded, visibleFilesWorktreePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    inlineInput,
    inlineInputIndex,
    startNew,
    startRename,
    dismissInlineInput,
    handleInlineSubmit
  } = useFileExplorerInlineInput({
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    expanded,
    rowProjection,
    scrollRef,
    refreshDir
  })
  const handleExplorerBackgroundDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!worktreePath || inlineInput) {
        return
      }
      const target = event.target as HTMLElement
      if (target.closest('[data-slot="context-menu-trigger"]')) {
        return
      }
      startNew('file', worktreePath, 0)
    },
    [inlineInput, startNew, worktreePath]
  )

  useFileExplorerWatch({
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    dirCache,
    setDirCache,
    expanded,
    setSelectedPath: setSingleSelectedPath,
    refreshDir,
    refreshTree,
    inlineInput,
    dragSourcePath,
    isNativeDragOver,
    operationOwner: rootCache?.operationOwner
  })

  useFileExplorerImport({
    worktreePath: visibleFilesWorktreePath,
    activeWorktreeId,
    refreshDir,
    clearNativeDragState,
    setSelectedPath: setSingleSelectedPath,
    operationOwner: rootCache?.operationOwner
  })

  const totalCount = visibleRowCount + (inlineInputIndex >= 0 ? 1 : 0)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => {
      if (inlineInputIndex >= 0) {
        if (index === inlineInputIndex) {
          return '__inline_input__'
        }
        const rowIndex = index > inlineInputIndex ? index - 1 : index
        return rowProjection.getRowAtIndex(rowIndex)?.path ?? `__fallback_${index}`
      }
      return rowProjection.getRowAtIndex(index)?.path ?? `__fallback_${index}`
    }
  })

  const cancelRevealTimers = useFileExplorerReveal({
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    pendingExplorerReveal,
    clearPendingExplorerReveal,
    expanded,
    dirCache,
    rootCache,
    rowProjection,
    loadDir,
    setSelectedPath: setSingleSelectedPath,
    setFlashingPath,
    flashTimeoutRef,
    virtualizer
  })
  const setExplorerShellRef = useCallback(
    (node: HTMLDivElement | null): void => {
      explorerShellRef.current = node
      if (node !== null) {
        return
      }
      // Why: reveal flash/scroll timers target the explorer shell; clear them
      // when that owner detaches instead of keeping a passive unmount Effect.
      cancelRevealTimers()
    },
    [cancelRevealTimers]
  )

  useFileExplorerAutoReveal({
    activeFileId,
    activeWorktreeId,
    worktreePath: visibleFilesWorktreePath,
    pendingExplorerReveal,
    openFiles,
    rowProjection,
    setSelectedPath: setSingleSelectedPath,
    virtualizer
  })

  useEffect(() => {
    if (inlineInputIndex >= 0) {
      virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' })
    }
  }, [inlineInputIndex, virtualizer])

  const selectedNode = selectedPath ? rowProjection.getRowByPath(selectedPath) : null
  const selectedNodes = useMemo(
    () => rowProjection.getRowsByPaths(selectedPaths),
    [rowProjection, selectedPaths]
  )
  const { handleClick, handleDoubleClick, handleWheelCapture, cancelPendingDirToggle } =
    useFileExplorerHandlers({
      activeWorktreeId,
      runtimeEnvironmentId: activeRuntimeEnvironmentId,
      openFile,
      makePreviewFilePermanent,
      toggleDir,
      loadDir,
      statPath,
      authorizeExternalPath: window.api.fs.authorizeExternalPath,
      markPathAsDirectory,
      setSelectedPath: setSingleSelectedPath,
      scrollRef
    })

  // Why: pass a stable activator so arrow-key navigation can hand the same
  // activate-toggles-folder / open-file-preview behavior the click handler
  // already uses, without the keyboard path re-implementing symlink handling.
  const activateNode = useCallback(
    (node: TreeNode) => {
      void handleClick(node)
    },
    [handleClick]
  )
  // Why: a rename can start while a name click is still holding back its
  // directory toggle; drop it so the tree doesn't shift under the input.
  const handleStartRename = useCallback(
    (node: TreeNode) => {
      cancelPendingDirToggle()
      startRename(node)
    },
    [cancelPendingDirToggle, startRename]
  )
  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    },
    [virtualizer]
  )

  useFileExplorerKeys({
    containerRef: explorerShellRef,
    rowProjection,
    expandedPaths: expanded,
    canToggleDirectories: true,
    inlineInput,
    selectedPaths,
    selectedNode,
    activateNode,
    moveSelection,
    toggleDir,
    startRename: handleStartRename,
    requestDelete,
    requestDeleteAll,
    scrollToIndex,
    activeWorktreeId
  })

  // Why: context-menu Delete should respect the multi-selection — if the
  // right-clicked node is already part of a multi-selection, delete the whole
  // set; otherwise fall through to single-node delete.
  const handleContextMenuDelete = useCallback(
    (node: TreeNode) => {
      if (selectedPaths.has(node.path) && selectedNodes.length > 1) {
        requestDeleteAll(selectedNodes)
      } else {
        requestDelete(node)
      }
    },
    [selectedPaths, selectedNodes, requestDelete, requestDeleteAll]
  )

  const handleDuplicate = useFileDuplicate({ activeWorktreeId, worktreePath, refreshDir })
  const handleRowClick = useCallback(
    (node: TreeNode, event: React.MouseEvent<HTMLButtonElement>) => {
      const dirToggle = resolveDirToggleTiming({
        fromRenameHotspot: isRenameHotspotTarget(event.target),
        clickCount: event.detail
      })
      selectRowWithModifiers(node, event, (target) => handleClick(target, dirToggle))
    },
    [handleClick, selectRowWithModifiers]
  )
  const handleCollapseFolderSubtree = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      collapseDirSubtree(activeWorktreeId, node.path)
    },
    [activeWorktreeId, collapseDirSubtree]
  )
  const handleFindInFolder = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      showRightSidebarSearch({
        includePattern: folderRelativePathToIncludeGlob(node.relativePath)
      })
    },
    [activeWorktreeId, showRightSidebarSearch]
  )

  const handleAddFolderAsProject = useCallback(
    (node: TreeNode) => {
      if (!activeRepo || !canShowAddAsProjectAction(node, activeRepo)) {
        return
      }
      openModal(
        'confirm-add-project-from-folder',
        buildAddProjectFromFolderModalData(node, activeRepo)
      )
    },
    [activeRepo, openModal]
  )
  const cppCodeIntelligenceScope =
    codeScopes.find((scope) => scope.language === 'cpp') ?? null
  const handleToggleCodeIntelligenceMembers = useCallback(
    (paths: readonly string[], action: 'add' | 'remove') => {
      const state = useAppStore.getState()
      // Folder sessions toggle the same-path folder repo's scope (#72 variant A).
      const repo =
        state.repos.find((candidate) => candidate.id === activeWorktree?.repoId) ??
        findSessionLinkedFolderRepo({
          activeWorktreeId,
          folderWorkspaces: state.folderWorkspaces,
          repos: state.repos
        })
      if (!repo) {
        return
      }
      const scope = findCodeIntelligenceScopeForWorkspace({
        settings: state.settings,
        repoId: repo.id,
        isFolder: isFolderRepo(repo),
        executionHostId: getRepoExecutionHostId(repo),
        language: 'cpp'
      })
      if (!scope) {
        return
      }
      const relativePaths = paths
        .map((path) => rowProjection.getRowByPath(path))
        .filter((node): node is TreeNode => Boolean(node?.isDirectory))
        .map((node) => node.relativePath)
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
    [activeWorktree?.repoId, activeWorktreeId, rowProjection]
  )
  const handleOpenInTerminal = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || !node.isDirectory) {
        return
      }
      createNewTerminalTab(activeWorktreeId, undefined, { startupCwd: node.path })
    },
    [activeWorktreeId]
  )

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.FileExplorer.79b1537dd3',
          'Select a workspace to browse files'
        )}
      </div>
    )
  }

  // Why: the root explorer container must stay mounted for loading, error,
  // and empty states so the data-native-file-drop-target marker is always
  // present. Without this, external file drops would have no target surface
  // when the tree is empty, still loading, or showing a read error.
  const isEmptyState = visibleRowCount === 0 && !inlineInput
  const isLoading = isEmptyState && (rootCache?.loading ?? true)
  const treeError = rootError
  const hasError = isEmptyState && !isLoading && !!treeError
  const showTree = !isEmptyState

  return (
    <>
      <div
        ref={setExplorerShellRef}
        data-orca-explorer-shell
        data-selected-folder-relative-path={
          selectedNode?.isDirectory ? selectedNode.relativePath : undefined
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <FileExplorerToolbar
          repoName={repoName}
          worktreePath={worktreePath}
          connectionId={activeRepo?.connectionId ?? null}
          refresh={manualRefresh}
          canRefresh
          canCollapseAll={canCollapseAll}
          onCollapseAll={handleCollapseAll}
          showGitIgnoredFilesToggle={activeRepoSupportsGit}
          showGitIgnoredFiles={showGitIgnoredFiles}
          onToggleGitIgnoredFiles={toggleGitIgnoredFiles}
          showDotfiles={showDotfiles}
          onToggleDotfiles={handleToggleDotfiles}
        />
        <OpenEditorsSection
          collapsed={openEditorsCollapsed}
          onToggleCollapsed={toggleOpenEditorsSection}
          fillRemaining={openEditorsFills}
        />
        <CodeScopesSection
          collapsed={codeScopesCollapsed}
          onToggleCollapsed={toggleCodeScopesSection}
          fillRemaining={codeScopesFills}
        />
        <WorktreeSection
          collapsed={worktreeSectionCollapsed}
          onToggleCollapsed={toggleWorktreeSection}
        >
          <ScrollArea
            className={cn(
              // Why: Radix ScrollArea.Root hard-sets inline `position: relative`,
              // defeating `absolute`; size by height so the viewport can overflow.
              'h-full min-h-0',
              isRootDragOver &&
                !(dragSourcePath && dirname(dragSourcePath) === worktreePath) &&
                'bg-border',
              isNativeDragOver && !nativeDropTargetDir && 'bg-border'
            )}
            viewportRef={scrollRef}
            viewportTabIndex={-1}
            viewportClassName="h-full min-h-0 py-2"
            data-native-file-drop-target="file-explorer"
            data-native-file-drop-dir={visibleFilesWorktreePath ?? undefined}
            onWheelCapture={handleWheelCapture}
            onDragOver={rootDragHandlers.onDragOver}
            onDragEnter={rootDragHandlers.onDragEnter}
            onDragLeave={rootDragHandlers.onDragLeave}
            onDrop={rootDragHandlers.onDrop}
            onDragEnd={() => {
              stopDragEdgeScroll()
              setDropTargetDir(null)
            }}
            viewportProps={{
              onContextMenuCapture: handleExplorerBackgroundContextMenuCapture,
              onDoubleClick: handleExplorerBackgroundDoubleClick
            }}
          >
            {!showTree && (
              <FileExplorerTreeStatus
                isLoading={isLoading}
                error={hasError ? treeError : null}
                isEmpty={isEmptyState && !isLoading && !hasError}
              />
            )}
            {showTree && (
              <FileExplorerVirtualRows
                virtualizer={virtualizer}
                inlineInputIndex={inlineInputIndex}
                rowProjection={rowProjection}
                inlineInput={inlineInput}
                handleInlineSubmit={handleInlineSubmit}
                dismissInlineInput={dismissInlineInput}
                folderStatusByRelativePath={folderStatusByRelativePath}
                statusByRelativePath={statusByRelativePath}
                ignoredByRelativePath={ignoredByRelativePath}
                expanded={expanded}
                canCollapseFolderSubtree
                dirCache={dirCache}
                selectedPaths={selectedPaths}
                activeFileId={activeFileId}
                flashingPath={flashingPath}
                deleteShortcutLabel={deleteShortcutLabel}
                connectionId={activeRepo?.connectionId ?? null}
                runtimeDownloadContext={runtimeDownloadContext}
                supportsFolderDownload={supportsFolderDownload}
                canOpenInOrcaBrowser={canOpenWorkspaceFileBrowserForPath}
                onClick={handleRowClick}
                onDoubleClick={handleDoubleClick}
                onViewFile={handleClick}
                onContextMenuSelect={preserveSelectionForContextMenu}
                onCopyPaths={copyPathsForNode}
                onStartNew={startNew}
                onStartRename={handleStartRename}
                onDuplicate={handleDuplicate}
                onAddFolderAsProject={handleAddFolderAsProject}
                canAddFolderAsProject={(node) => canShowAddAsProjectAction(node, activeRepo)}
                codeIntelligenceScope={cppCodeIntelligenceScope}
                onToggleCodeIntelligenceMembers={handleToggleCodeIntelligenceMembers}
                onOpenInTerminal={handleOpenInTerminal}
                onRequestDelete={handleContextMenuDelete}
                onCollapseFolderSubtree={handleCollapseFolderSubtree}
                onFindInFolder={handleFindInFolder}
                onMoveDrop={handleMoveDrop}
                onDragTargetChange={setDropTargetDir}
                onDragSourceChange={setDragSourcePath}
                onDragExpandDir={handleDragExpandDir}
                onNativeDragTargetChange={setNativeDropTargetDir}
                onNativeDragExpandDir={handleNativeDragExpandDir}
                dropTargetDir={dropTargetDir}
                dragSourcePath={dragSourcePath}
                nativeDropTargetDir={nativeDropTargetDir}
              />
            )}
          </ScrollArea>
        </WorktreeSection>
      </div>

      <FileExplorerBackgroundMenu
        open={bgMenuOpen}
        onOpenChange={setBgMenuOpen}
        point={bgMenuPoint}
        worktreePath={worktreePath}
        onStartNew={startNew}
      />
    </>
  )
}


const FileExplorerFilesMemo = React.memo(FileExplorerFiles)

function FileExplorer(): React.JSX.Element {
  return <FileExplorerFilesMemo />
}

export default React.memo(FileExplorer)
