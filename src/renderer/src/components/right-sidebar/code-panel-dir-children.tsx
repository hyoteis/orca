import React from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FileRowMenuItems, stopRightButtonMenuSelection } from './file-explorer-row-menu'
import { InlineInputRow } from './FileExplorerRow'
import type { LazyDirectoryListing } from './use-lazy-directory-listing'
import type { CodeScopeTreeContext } from './use-code-scopes-section'
import type { TreeNode } from './file-explorer-types'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'

/** Workspace-relative path, degrading to the entry name for external member dirs. */
function scopeEntryRelativePath(path: string, worktreePath: string | null, name: string): string {
  if (worktreePath && path.length > worktreePath.length && path.startsWith(worktreePath)) {
    return normalizeRelativePath(path.slice(worktreePath.length + 1))
  }
  return name
}

/** Directory subtree rows shared by the panel's member trees (browse view). */
export function CodePanelDirChildren({
  dirPath,
  depth,
  listing,
  onOpenFile,
  tree
}: {
  dirPath: string
  depth: number
  listing: LazyDirectoryListing
  onOpenFile: (filePath: string, fileName: string) => void
  tree: CodeScopeTreeContext
}): React.JSX.Element[] | null {
  const { expandedDirs, entriesByDir, errorByDir, toggleDir } = listing
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
  const { actions, worktreePath } = tree
  const operationOwner = getFileExplorerOperationOwner(actions.activeWorktreeId)
  // Directories first so folder groups lead each level; alphabetical within each group.
  const sorted = [...entries].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
  )
  const rows: React.JSX.Element[] = sorted.map((entry) => {
    const childPath = joinPath(dirPath, entry.name)
    const node: TreeNode = {
      name: entry.name,
      path: childPath,
      relativePath: scopeEntryRelativePath(childPath, worktreePath, entry.name),
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth,
      operationOwner
    }
    const inline = actions.inlineInput
    if (inline && inline.type === 'rename' && inline.existingPath === childPath) {
      return (
        <InlineInputRow
          key={`${childPath}\0rename`}
          depth={depth}
          inlineInput={inline}
          onSubmit={actions.submitInlineInput}
          onCancel={actions.dismissInlineInput}
        />
      )
    }
    const expanded = expandedDirs.has(childPath)
    const menu = (
      <FileRowMenuItems
        node={node}
        connectionId={actions.connectionId}
        isExpanded={expanded}
        canCollapseFolderSubtree
        deleteShortcutLabel={actions.deleteShortcutLabel}
        canAddAsProject={actions.canAddFolderAsProject(node)}
        onAddFolderAsProject={() => actions.addFolderAsProject(node)}
        codeIntelligenceScope={actions.codeIntelligenceScope}
        onToggleCodeIntelligenceMembers={actions.toggleCodeIntelligenceMembers}
        supportsFolderDownload={tree.supportsFolderDownload}
        runtimeDownloadContext={tree.runtimeDownloadContext}
        canOpenInOrcaBrowser={tree.canOpenInOrcaBrowser(childPath)}
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
    )
    const content = entry.isDirectory ? (
      <>
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
      </>
    ) : (
      <>
        <span className="size-3 shrink-0" />
        {(() => {
          const FileIcon = getFileTypeIcon(entry.name)
          return <FileIcon className="size-3 shrink-0 text-muted-foreground" />
        })()}
      </>
    )
    return (
      <React.Fragment key={childPath}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              className="flex h-[26px] w-full items-center gap-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
              title={childPath}
              onClick={() =>
                entry.isDirectory ? toggleDir(childPath) : onOpenFile(childPath, entry.name)
              }
            >
              {content}
              <span className="truncate">{entry.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]"
            onPointerUpCapture={stopRightButtonMenuSelection}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {menu}
          </ContextMenuContent>
        </ContextMenu>
        <CodePanelDirChildren
          dirPath={childPath}
          depth={depth + 1}
          listing={listing}
          onOpenFile={onOpenFile}
          tree={tree}
        />
      </React.Fragment>
    )
  })
  // ponytail: create-input appends at the list end (worktree's after-subtree insert), not typed-in-place.
  const createInline = actions.inlineInput
  if (createInline && createInline.type !== 'rename' && createInline.parentPath === dirPath) {
    rows.push(
      <InlineInputRow
        key={`${dirPath}\0new`}
        depth={createInline.depth}
        inlineInput={createInline}
        onSubmit={actions.submitInlineInput}
        onCancel={actions.dismissInlineInput}
      />
    )
  }
  return rows
}
