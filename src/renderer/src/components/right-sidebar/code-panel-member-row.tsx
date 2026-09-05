import React from 'react'
import { ChevronRight, ExternalLink, FolderInput, Settings2, ShieldOff, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { CodePanelMemberRow } from './code-panel-member-tree'
import { LanguageBadge } from './code-panel-language-badge'
import { CodePanelDirChildren } from './code-panel-dir-children'
import { FileRowMenuItems, stopRightButtonMenuSelection } from './file-explorer-row-menu'
import { InlineInputRow } from './FileExplorerRow'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import type { LazyDirectoryListing } from './use-lazy-directory-listing'
import type { CodeScopeTreeContext } from './use-code-scopes-section'

/** One scope member: browsable dir row + scope actions plus the worktree row menu (#70, #81). */
export function CodePanelMemberTreeRow({
  row,
  listing,
  configureRepoId,
  tree,
  onOpenAsWorkspace,
  onReveal,
  onRemove,
  onOpenFile
}: {
  row: CodePanelMemberRow
  listing: LazyDirectoryListing
  configureRepoId: string | null
  tree: CodeScopeTreeContext
  onOpenAsWorkspace: (row: CodePanelMemberRow) => void
  onReveal: (row: CodePanelMemberRow) => void
  onRemove: (row: CodePanelMemberRow) => void
  onOpenFile: (filePath: string, fileName: string) => void
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const { expandedDirs, toggleDir } = listing
  const dirPath = row.directory
  const expanded = expandedDirs.has(dirPath)
  const { actions } = tree
  // Renaming a member replaces its row with the shared inline input; the
  // input otherwise has no parent listing to render inside (the workspace root).
  const inline = actions.inlineInput
  if (inline && inline.type === 'rename' && inline.existingPath === dirPath) {
    return (
      <InlineInputRow
        depth={0}
        inlineInput={inline}
        onSubmit={actions.submitInlineInput}
        onCancel={actions.dismissInlineInput}
      />
    )
  }
  // Flush with the section edge (8px base, same as the Files tree top level);
  // children continue one level deeper via CodePanelDirChildren (14px/level).
  const node = {
    name: row.displayName,
    path: dirPath,
    relativePath: row.path,
    isDirectory: true,
    depth: 0,
    operationOwner: getFileExplorerOperationOwner(actions.activeWorktreeId)
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className="flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-[13px] text-foreground hover:bg-accent"
          style={{ paddingLeft: '8px' }}
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
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.displayName}</span>
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
        <ContextMenuItem onSelect={() => onOpenAsWorkspace(row)}>
          <FolderInput />
          {translate('auto.components.rightSidebar.CodePanel.openAsWorkspace', 'Open as Workspace')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onReveal(row)}>
          <ExternalLink />
          {translate('auto.components.rightSidebar.CodePanel.reveal', 'Reveal in File Manager')}
        </ContextMenuItem>
        {row.languages.includes('cpp') && configureRepoId ? (
          <ContextMenuItem
            onSelect={() => openModal('code-intelligence-cpp-setup', { repoId: configureRepoId })}
          >
            <Settings2 />
            {translate('auto.components.rightSidebar.CodePanel.configureCode', 'Configure Code…')}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem variant="destructive" onSelect={() => onRemove(row)}>
          <Trash2 />
          {translate('auto.components.rightSidebar.CodePanel.remove', 'Remove')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <FileRowMenuItems
          node={node}
          connectionId={actions.connectionId}
          isExpanded={expanded}
          canCollapseFolderSubtree
          showReveal={false}
          deleteShortcutLabel={actions.deleteShortcutLabel}
          canAddAsProject={actions.canAddFolderAsProject(node)}
          onAddFolderAsProject={() => actions.addFolderAsProject(node)}
          codeIntelligenceScope={actions.codeIntelligenceScope}
          onToggleCodeIntelligenceMembers={actions.toggleCodeIntelligenceMembers}
          supportsFolderDownload={tree.supportsFolderDownload}
          runtimeDownloadContext={tree.runtimeDownloadContext}
          onStartNew={actions.startNew}
          onStartRename={actions.startRename}
          onDuplicate={actions.duplicate}
          onCopyPaths={(pathKind) => actions.copyPaths(node, pathKind)}
          onOpenInTerminal={() => actions.openInTerminal(node)}
          onViewFile={() => actions.viewFile(node)}
          onCollapseFolderSubtree={() => actions.collapseFolder(node)}
          onFindInFolder={() => actions.findInFolder(node)}
          onRequestDelete={() => actions.requestDelete(node)}
        />
      </ContextMenuContent>
      <CodePanelDirChildren
        dirPath={dirPath}
        depth={1}
        listing={listing}
        onOpenFile={onOpenFile}
        tree={tree}
      />
    </ContextMenu>
  )
}
