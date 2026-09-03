import React, { useState } from 'react'
import { Ghost, Link, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CodePanelAddFolderDialog } from './CodePanelAddFolderDialog'
import { LANGUAGE_DISPLAY } from './code-panel-language-badge'
import { LanguageBadge } from './code-panel-language-badge'
import {
  FolderBridgeInfoLine,
  FolderNotProjectEmptyState
} from './code-panel-folder-bridge-state'
import { CodePanelMemberTreeRow } from './code-panel-member-row'
import {
  useCodeScopesSection,
  type CodePanelDirectoryLister
} from './use-code-scopes-section'

export type { CodePanelDirectoryLister } from './use-code-scopes-section'

export function CodePanel({
  listDirectory
}: {
  listDirectory?: CodePanelDirectoryLister
}): React.JSX.Element {
  const section = useCodeScopesSection({ listDirectory })
  const {
    scopes,
    rows,
    keptEmptyLanguages,
    configureRepoId,
    folderWorkspace,
    linkedFolderRepo,
    bridged,
    addFolderSeed,
    hostLabel,
    listing,
    list
  } = section
  const { pendingDirs } = listing
  const [addFolderOpen, setAddFolderOpen] = useState(false)

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
        {linkedFolderRepo ? (
          <span
            className="flex max-w-[11rem] items-center gap-1 truncate rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground"
            title={translate(
              'auto.components.rightSidebar.CodePanel.bridgedInfo',
              'Code folders come from the linked project {{value0}}; changes here write back to it.',
              { value0: linkedFolderRepo.displayName }
            )}
          >
            <Link className="size-3 shrink-0" />
            <span className="truncate">{linkedFolderRepo.displayName}</span>
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
        {bridged ? <FolderBridgeInfoLine repoName={linkedFolderRepo?.displayName ?? ''} /> : null}
        {rows.length > 0
          ? rows.map((row) => (
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
            ))
          : folderWorkspace && !linkedFolderRepo
            ? <FolderNotProjectEmptyState onAddAsProject={section.addWorkspaceFolderAsProject} />
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
