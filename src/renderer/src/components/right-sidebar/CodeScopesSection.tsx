import React, { useEffect } from 'react'
import { ChevronDown, ChevronRight, Loader2, Settings2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { FolderBridgeInfoLine, FolderNotProjectEmptyState } from './code-panel-folder-bridge-state'
import { CodePanelMemberTreeRow } from './code-panel-member-row'
import { CodePanelDirChildren } from './code-panel-dir-children'
import { useCodeScopesSection, type CodePanelDirectoryLister } from './use-code-scopes-section'

/** Explorer's "Code scopes" section — the migrated Code panel member tree (#81). */
export function CodeScopesSection({
  listDirectory,
  collapsed,
  onToggleCollapsed,
  fillRemaining = false
}: {
  listDirectory?: CodePanelDirectoryLister
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Take the panel space freed by a collapsed Worktree section instead of capping. */
  fillRemaining?: boolean
}): React.JSX.Element | null {
  const section = useCodeScopesSection({ listDirectory })
  const {
    scopes,
    rows,
    configureRepoId,
    folderWorkspace,
    linkedFolderRepo,
    bridged,
    listing,
    tree,
    openFile
  } = section
  const { pendingDirs, expandedDirs, toggleDir } = listing
  const openModal = useAppStore((s) => s.openModal)

  // Hidden only when nothing can render AND no configure target exists — a
  // scope-less session keeps the section as the cold-start entry (#76: the
  // setup dialog owns folder add/remove, so the gear must stay reachable).
  const folderGap = folderWorkspace !== null && linkedFolderRepo === null
  const sectionHidden = scopes.length === 0 && !bridged && !folderGap && configureRepoId === null

  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  // Whole-folder scopes ('.') drop their root-name row: children render directly
  // at indent level 1, so the root expands itself instead of showing its name.
  const wholeFolderRows = rows.filter((row) => row.path === '.' && !row.browseBlocked)
  useEffect(() => {
    if (collapsed) {
      return
    }
    for (const row of wholeFolderRows) {
      if (!expandedDirs.has(row.directory)) {
        toggleDir(row.directory)
      }
    }
  }, [collapsed, expandedDirs, toggleDir, wholeFolderRows])

  if (sectionHidden) {
    return null
  }

  // One-time (#128 armed it): covers the python removal + BASIC migration;
  // dismissal persists through the flag flip, never returns.
  const upgradeNoticePending = settings?.codeIntelligenceModelUpgradeNoticePending === true

  return (
    <div className={cn(!collapsed && fillRemaining && 'flex min-h-0 flex-1 flex-col')}>
      {upgradeNoticePending && !collapsed ? (
        <div className="flex items-start gap-1.5 border-b border-explorer-section-divider bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground" role="status">
          <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {translate('settings.codeIntelligence.upgradeNoticeTitle', 'C++ code intelligence was upgraded')}
            </span>
            <p className="mt-0.5 leading-snug">
              {translate('settings.codeIntelligence.upgradeNoticeBody', 'Python code intelligence was removed, and existing C++ scopes moved to the new mapped-database and BASIC model. Open Configure Code to review your folders.')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 shrink-0 px-1.5 text-[10px]"
            onClick={() => {
              void updateSettings({ codeIntelligenceModelUpgradeNoticePending: false })
            }}
          >
            {translate('settings.codeIntelligence.upgradeNoticeDismiss', 'Got it')}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 border-y border-explorer-section-divider px-1 py-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={translate(
            'auto.components.right.sidebar.CodeScopesSection.toggleSection',
            'Toggle workspace section'
          )}
          onClick={onToggleCollapsed}
          className="flex w-full items-center gap-1 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          {translate('auto.components.right.sidebar.CodeScopesSection.title', 'Workspace')}
          <span className="ml-auto tabular-nums">{rows.length}</span>
        </button>
        {/* #76: configure is the section's single affordance — the setup dialog
            owns folder add/remove via its directory picker. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.CodeScopesSection.configureCode',
            'Configure Code'
          )}
          disabled={!configureRepoId}
          onClick={() => openModal('code-intelligence-cpp-setup', { repoId: configureRepoId })}
        >
          <Settings2 className="size-3" />
        </Button>
      </div>
      {!collapsed && (
        /* Why: the tree shares the worktree tree's scroll contract — wheel-scrollable,
           capped while the worktree section below is open; fillRemaining drops the cap so
           a solo-expanded section owns the freed panel height. The cap must also reach the
           viewport or Radix sees no overflow and renders no scrollbar. */
        <ScrollArea
          className={fillRemaining ? 'min-h-0 flex-1' : 'max-h-64'}
          viewportClassName={fillRemaining ? 'h-full min-h-0' : 'max-h-64'}
        >
          {bridged ? <FolderBridgeInfoLine repoName={linkedFolderRepo?.displayName ?? ''} /> : null}
          {rows.map((row) =>
            row.path === '.' && !row.browseBlocked ? (
              <CodePanelDirChildren
                key={row.directory}
                dirPath={row.directory}
                depth={0}
                listing={listing}
                onOpenFile={openFile}
                tree={tree}
              />
            ) : (
              <CodePanelMemberTreeRow
                key={row.path}
                row={row}
                listing={listing}
                configureRepoId={configureRepoId}
                tree={tree}
                onOpenAsWorkspace={section.openAsWorkspace}
                onReveal={section.reveal}
                onRemove={section.remove}
                onOpenFile={openFile}
              />
            )
          )}
          {rows.length === 0 && folderGap ? (
            <FolderNotProjectEmptyState onAddAsProject={section.addWorkspaceFolderAsProject} />
          ) : null}
          {pendingDirs.size > 0 ? (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {translate('auto.components.rightSidebar.CodePanel.loading', 'Loading…')}
            </div>
          ) : null}
        </ScrollArea>
        )}
    </div>
  )
}
