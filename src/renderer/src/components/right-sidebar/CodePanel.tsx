import React, { useCallback, useMemo, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, Ghost, Loader2, Plus, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useWorktreeMap } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { joinPath } from '@/lib/path'
import type { DirEntry, Worktree } from '../../../../shared/types'
import type {
  CodeIntelligenceLanguage
} from '../../../../shared/code-intelligence-scope'
import { getExecutionHostLabel, getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getStatusBarCodeIntelligenceScopes } from '../status-bar/code-intelligence-status-scopes'
import {
  buildCodePanelMemberRows,
  getCodePanelKeptEmptyLanguages,
  type CodePanelMemberRow
} from './code-panel-member-tree'
import { readFileExplorerDirectory } from './file-explorer-directory-listing'

const LANGUAGE_DISPLAY: Record<CodeIntelligenceLanguage, string> = { cpp: 'C++', python: 'Python' }
const LANGUAGE_BADGE: Record<CodeIntelligenceLanguage, string> = { cpp: 'C++', python: 'Py' }

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
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingDirs, setPendingDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({})
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({})

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

  const toggleDir = useCallback(
    (dirPath: string): void => {
      setExpandedDirs((current) => {
        const next = new Set(current)
        if (next.has(dirPath)) {
          next.delete(dirPath)
        } else {
          next.add(dirPath)
        }
        return next
      })
      if (entriesByDir[dirPath] === undefined && !pendingDirs.has(dirPath)) {
        setPendingDirs((current) => new Set(current).add(dirPath))
        void list(dirPath)
          .then((entries) => {
            setEntriesByDir((current) => ({ ...current, [dirPath]: entries }))
            setErrorByDir((current) => {
              const { [dirPath]: _dropped, ...rest } = current
              return rest
            })
          })
          .catch(() => {
            setErrorByDir((current) => ({
              ...current,
              [dirPath]: translate(
                'auto.components.rightSidebar.CodePanel.listFailed',
                'Could not list this folder'
              )
            }))
          })
          .finally(() => {
            setPendingDirs((current) => {
              const next = new Set(current)
              next.delete(dirPath)
              return next
            })
          })
      }
    },
    [entriesByDir, list, pendingDirs]
  )

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
      <React.Fragment key={row.path}>
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
        {renderDirChildren(dirPath, 1)}
      </React.Fragment>
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
        {/* Add Folder lands with the in-app tree picker (#71); placeholder only. */}
        <Button type="button" variant="outline" size="xs" disabled className="gap-1.5">
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
              </div>
            )}
        {keptEmptyLanguages.map((language) => (
          <div
            key={language}
            className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"
          >
            <LanguageBadge language={language} />
            {translate('auto.components.rightSidebar.CodePanel.scopeEmptyKept', '{{value0}} scope is empty — kept', {
              value0: LANGUAGE_DISPLAY[language]
            })}
          </div>
        ))}
        {pendingDirs.size > 0 ? (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {translate('auto.components.rightSidebar.CodePanel.loading', 'Loading…')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default CodePanel
