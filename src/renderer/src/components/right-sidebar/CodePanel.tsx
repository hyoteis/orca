import React, { useCallback, useMemo, useState } from 'react'
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  Ghost,
  Loader2,
  Plus,
  Settings2,
  ShieldOff,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useWorktreeMap } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { joinPath } from '@/lib/path'
import {
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast
} from '@/lib/local-path-open-guard'
import { writeCodeIntelligenceScopeEdit } from '@/lib/language-server/code-intelligence-scope-member-edit'
import type { DirEntry, Worktree } from '../../../../shared/types'
import type {
  CodeIntelligenceLanguage
} from '../../../../shared/code-intelligence-scope'
import { getExecutionHostLabel, getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getStatusBarCodeIntelligenceScopes } from '../status-bar/code-intelligence-status-scopes'
import { buildAddProjectFromFolderModalData } from './file-explorer-add-project-action'
import {
  buildCodePanelMemberRows,
  getCodePanelKeptEmptyLanguages,
  removeCodePanelMemberRow,
  type CodePanelMemberRow
} from './code-panel-member-tree'
import { readFileExplorerDirectory } from './file-explorer-directory-listing'
import { CodePanelAddFolderDialog, type CodePanelAddFolderScopeSeed } from './CodePanelAddFolderDialog'
import { useLazyDirectoryListing } from './use-lazy-directory-listing'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

const LANGUAGE_DISPLAY: Record<CodeIntelligenceLanguage, string> = { cpp: 'C++', python: 'Python' }
const LANGUAGE_BADGE: Record<CodeIntelligenceLanguage, string> = { cpp: 'C++', python: 'Py' }

function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: Radix opens context menus under the pointer; on some macOS/Electron
  // paths the right-button release lands on the first item and selects it.
  event.preventDefault()
}

function LanguageBadge({ language }: { language: CodeIntelligenceLanguage }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-[15px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-semibold leading-none',
        language === 'cpp'
          ? 'border border-border bg-secondary text-secondary-foreground'
          : 'border border-dashed border-border text-muted-foreground'
      )}
    >
      {LANGUAGE_BADGE[language]}
    </span>
  )
}

export type CodePanelDirectoryLister = (dirPath: string) => Promise<DirEntry[]>

export function CodePanel({
  listDirectory
}: {
  listDirectory?: CodePanelDirectoryLister
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const worktreeMap = useWorktreeMap()

  const activeWorktree = activeWorktreeId ? (worktreeMap.get(activeWorktreeId) ?? null) : null
  const folderWorkspace = useMemo(() => {
    const parsed = activeWorktreeId ? parseWorkspaceKey(activeWorktreeId) : null
    return parsed?.type === 'folder'
      ? (folderWorkspaces.find((candidate) => folderWorkspaceKey(candidate.id) === activeWorktreeId) ??
        null)
      : null
  }, [activeWorktreeId, folderWorkspaces])
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
    () => getStatusBarCodeIntelligenceScopes({ settings, activeWorktreeId, executionHostId }),
    [settings, activeWorktreeId, executionHostId]
  )
  const rows = useMemo(() => buildCodePanelMemberRows(scopes), [scopes])
  const keptEmptyLanguages = useMemo(() => getCodePanelKeptEmptyLanguages(scopes), [scopes])
  const openModal = useAppStore((s) => s.openModal)
  // Configure routes to the existing C++ setup dialog, which pre-checks the
  // scope's current members itself (single source of truth, #63 decision 4).
  const configureRepoId = useMemo(() => {
    const cppScope = scopes.find((scope) => scope.language === 'cpp')
    const parsed = cppScope ? parseWorkspaceKey(cppScope.workspaceKey) : null
    return parsed ? (parsed.type === 'folder' ? parsed.folderWorkspaceId : parsed.worktreeId) : null
  }, [scopes])

  const handleOpenAsWorkspace = (row: CodePanelMemberRow): void => {
    if (!activeRepo) {
      return
    }
    openModal(
      'confirm-add-project-from-folder',
      buildAddProjectFromFolderModalData({ path: row.directory }, activeRepo)
    )
  }
  const handleReveal = (row: CodePanelMemberRow): void => {
    if (isLocalPathOpenBlocked(settings, { connectionId: activeRepo?.connectionId ?? null })) {
      showLocalPathOpenBlockedToast()
      return
    }
    window.api.shell.openPath(row.directory)
  }
  const handleRemove = (row: CodePanelMemberRow): void => {
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
  const { expandedDirs, pendingDirs, entriesByDir, errorByDir, toggleDir } =
    useLazyDirectoryListing(list)

  const [addFolderOpen, setAddFolderOpen] = useState(false)
  // Creation seed mirrors the status-bar scope lookup (repoId + folder flag).
  const addFolderSeed: CodePanelAddFolderScopeSeed | null = useMemo(() => {
    if (!activeWorktreeId || !effectiveWorktree || !activeRepo || !executionHostId) {
      return null
    }
    return {
      repoId: getRepoIdFromWorktreeId(activeWorktreeId),
      repoName: activeRepo.displayName,
      repoPath: effectiveWorktree.path,
      isFolder: parseWorkspaceKey(activeWorktreeId)?.type === 'folder',
      executionHostId
    }
  }, [activeWorktreeId, effectiveWorktree, activeRepo, executionHostId])

  const renderDirChildren = (dirPath: string, depth: number): React.JSX.Element[] | null => {
    if (!expandedDirs.has(dirPath)) {
      return null
    }
    const entries = entriesByDir[dirPath]
    if (!entries) {
      const error = errorByDir[dirPath]
      return error
        ? [
            <div
              key={`${dirPath}\0error`}
              className="px-2 py-1 pl-3 text-[11px] text-muted-foreground"
            >
              {error}
            </div>
          ]
        : null
    }
    return entries.map((entry) => {
      const childPath = joinPath(dirPath, entry.name)
      if (!entry.isDirectory) {
        return (
          <div
            key={childPath}
            className="flex h-[24px] items-center gap-1.5 font-mono text-xs text-foreground"
            style={{ paddingLeft: `${depth * 14 + 22}px` }}
          >
            <span className="size-3 shrink-0" />
            <span className="truncate">{entry.name}</span>
          </div>
        )
      }
      const expanded = expandedDirs.has(childPath)
      return (
        <React.Fragment key={childPath}>
          <button
            type="button"
            className="flex h-[24px] w-full items-center gap-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => toggleDir(childPath)}
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            {expanded ? (
              <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {renderDirChildren(childPath, depth + 1)}
        </React.Fragment>
      )
    })
  }

  const renderMemberRow = (row: CodePanelMemberRow): React.JSX.Element => {
    const dirPath = row.directory
    const expanded = expandedDirs.has(dirPath)
    return (
      <ContextMenu key={row.path}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="flex h-[26px] w-full items-center gap-1.5 px-2 text-left text-[13px] text-foreground hover:bg-accent"
            title={
              row.browseBlocked
                ? translate(
                    'auto.components.rightSidebar.CodePanel.browseBlocked',
                    'Authorize code intelligence to browse this folder'
                  )
                : dirPath
            }
            onClick={() => {
              if (!row.browseBlocked) {
                toggleDir(dirPath)
              }
            }}
          >
            {row.browseBlocked ? (
              <ShieldOff className="size-3 shrink-0 text-amber-500" />
            ) : (
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-90'
                )}
              />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.path}</span>
            {row.languages.map((language) => (
              <LanguageBadge key={language} language={language} />
            ))}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]"
          onPointerUpCapture={stopRightButtonMenuSelection}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenuItem onSelect={() => handleOpenAsWorkspace(row)}>
            <FolderInput />
            {translate('auto.components.rightSidebar.CodePanel.openAsWorkspace', 'Open as Workspace')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleReveal(row)}>
            <ExternalLink />
            {translate('auto.components.rightSidebar.CodePanel.reveal', 'Reveal in File Manager')}
          </ContextMenuItem>
          {row.languages.includes('cpp') && configureRepoId ? (
            <ContextMenuItem onSelect={() => openModal('code-intelligence-cpp-setup', { repoId: configureRepoId })}>
              <Settings2 />
              {translate('auto.components.rightSidebar.CodePanel.configureCode', 'Configure Code…')}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => handleRemove(row)}>
            <Trash2 />
            {translate('auto.components.rightSidebar.CodePanel.remove', 'Remove')}
          </ContextMenuItem>
        </ContextMenuContent>
        {renderDirChildren(dirPath, 1)}
      </ContextMenu>
    )
  }

  const hostLabel = executionHostId ? getExecutionHostLabel(executionHostId) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.rightSidebar.CodePanel.title', 'Code')}
        </span>
        {hostLabel ? (
          <span
            className="max-w-[11rem] truncate rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={hostLabel}
          >
            {hostLabel}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1.5"
          disabled={!addFolderSeed}
          onClick={() => setAddFolderOpen(true)}
        >
          <Plus className="size-3.5" />
          {translate('auto.components.rightSidebar.CodePanel.addFolder', 'Add Folder')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek py-1">
        {rows.length > 0
          ? rows.map(renderMemberRow)
          : scopes.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-7 text-center">
                <Ghost className="size-7 text-muted-foreground/60" />
                <div className="text-[13px] text-foreground">
                  {translate(
                    'auto.components.rightSidebar.CodePanel.emptyTitle',
                    'No code scopes for this workspace on this host.'
                  )}
                </div>
                <div className="max-w-[16rem] text-xs text-muted-foreground">
                  {translate(
                    'auto.components.rightSidebar.CodePanel.emptyCopy',
                    'Add a folder to create a C++ or Python scope.'
                  )}
                </div>
                <Button
                  type="button"
                  size="xs"
                  className="gap-1.5"
                  disabled={!addFolderSeed}
                  onClick={() => setAddFolderOpen(true)}
                >
                  <Plus className="size-3.5" />
                  {translate('auto.components.rightSidebar.CodePanel.addFolder', 'Add Folder')}
                </Button>
              </div>
            )}
        {keptEmptyLanguages.map((language) => (
          <div
            key={language}
            className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"
          >
            <LanguageBadge language={language} />
            <span className="min-w-0 flex-1 truncate">
              {translate('auto.components.rightSidebar.CodePanel.scopeEmptyKept', '{{value0}} scope is empty — kept', {
                value0: LANGUAGE_DISPLAY[language]
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5 gap-1 px-1.5"
              disabled={!addFolderSeed}
              onClick={() => setAddFolderOpen(true)}
            >
              <Plus className="size-3" />
              {translate('auto.components.rightSidebar.CodePanel.addFolder', 'Add Folder')}
            </Button>
          </div>
        ))}
        {pendingDirs.size > 0 ? (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {translate('auto.components.rightSidebar.CodePanel.loading', 'Loading…')}
          </div>
        ) : null}
      </div>
      {addFolderSeed && addFolderOpen ? (
        <CodePanelAddFolderDialog
          onOpenChange={setAddFolderOpen}
          scopes={scopes}
          scopeSeed={addFolderSeed}
          workspaceRootPath={addFolderSeed.repoPath}
          listDirectory={list}
        />
      ) : null}
    </div>
  )
}

export default CodePanel
