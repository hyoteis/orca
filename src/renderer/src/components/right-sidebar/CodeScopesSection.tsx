import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { LANGUAGE_DISPLAY, LanguageBadge } from './code-panel-language-badge'
import {
  FolderBridgeInfoLine,
  FolderNotProjectEmptyState
} from './code-panel-folder-bridge-state'
import { CodePanelMemberTreeRow } from './code-panel-member-row'
import {
  useCodeScopesSection,
  type CodePanelDirectoryLister
} from './use-code-scopes-section'

/** Explorer's "Code scopes" section — the migrated Code panel member tree (#81). */
export function CodeScopesSection({
  listDirectory
}: {
  listDirectory?: CodePanelDirectoryLister
}): React.JSX.Element | null {
  const section = useCodeScopesSection({ listDirectory })
  const {
    scopes,
    rows,
    keptEmptyLanguages,
    configureRepoId,
    folderWorkspace,
    linkedFolderRepo,
    bridged,
    hostLabel,
    listing
  } = section
  const { pendingDirs } = listing
  const openModal = useAppStore((s) => s.openModal)
  const [collapsed, setCollapsed] = useState(false)

  // Hidden when nothing can render — OpenEditorsSection's precedent for empty sections.
  const folderGap = folderWorkspace !== null && linkedFolderRepo === null
  if (scopes.length === 0 && !bridged && !folderGap) {
    return null
  }

  return (
    <div className="border-b border-border py-1">
      <div className="flex items-center gap-0.5 px-1 pb-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={translate(
            'auto.components.right.sidebar.CodeScopesSection.toggleSection',
            'Toggle Code scopes section'
          )}
          onClick={() => setCollapsed((value) => !value)}
          className="flex w-full items-center gap-1 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          {translate('auto.components.right.sidebar.CodeScopesSection.title', 'Code scopes')}
          {hostLabel ? (
            <span
              className="max-w-[8rem] truncate rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-muted-foreground"
              title={hostLabel}
            >
              {hostLabel}
            </span>
          ) : null}
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
      {/* ponytail: collapse state is session-local, matching OpenEditorsSection. */}
      {!collapsed && (
        <>
          {bridged ? <FolderBridgeInfoLine repoName={linkedFolderRepo?.displayName ?? ''} /> : null}
          {rows.map((row) => (
            <CodePanelMemberTreeRow
              key={row.path}
              row={row}
              listing={listing}
              configureRepoId={configureRepoId}
              onOpenAsWorkspace={section.openAsWorkspace}
              onReveal={section.reveal}
              onRemove={section.remove}
              onOpenFile={section.openFile}
            />
          ))}
          {rows.length === 0 && folderGap ? (
            <FolderNotProjectEmptyState onAddAsProject={section.addWorkspaceFolderAsProject} />
          ) : null}
          {keptEmptyLanguages.map((language) => (
            <div
              key={language}
              className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"
            >
              <LanguageBadge language={language} />
              <span className="min-w-0 flex-1 truncate">
                {translate(
                  'auto.components.rightSidebar.CodePanel.scopeEmptyKept',
                  '{{value0}} scope is empty — kept',
                  { value0: LANGUAGE_DISPLAY[language] }
                )}
              </span>
            </div>
          ))}
          {pendingDirs.size > 0 ? (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {translate('auto.components.rightSidebar.CodePanel.loading', 'Loading…')}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
