import { useCallback } from 'react'
import type React from 'react'
import {
  Braces,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FilePlus,
  Files,
  FolderPlus,
  Globe,
  ListCollapse,
  Pencil,
  Search,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { dirname } from '@/lib/path'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { detectLanguage } from '@/lib/language-detect'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { getCodeIntelligenceMembershipAction } from '@/lib/language-server/code-intelligence-scope-membership'
import { translate } from '@/i18n/i18n'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { getCodeIntelligenceMenuTargetPaths } from './file-explorer-code-intelligence-action'
import {
  copyFileToOsClipboard,
  downloadRemoteFile,
  revealLabel,
  shouldShowCollapseFolderAction,
  shouldShowCopyFileAction,
  shouldShowFindInFolderAction,
  shouldShowOpenInTerminalAction,
  shouldShowRemoteDownloadAction,
  shouldShowViewFileAction
} from './file-explorer-row-menu-actions'
import type { TreeNode } from './file-explorer-types'

const isMac = navigator.userAgent.includes('Mac')

export function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: Radix opens context menus under the pointer; on some macOS/Electron
  // paths the right-button release lands on the first item and selects it.
  event.preventDefault()
  event.stopPropagation()
}

export type FileRowMenuItemsProps = {
  node: TreeNode
  connectionId?: string | null
  selectionSize?: number
  runtimeDownloadContext?: RuntimeFileOperationArgs | null
  supportsFolderDownload?: boolean
  canOpenInOrcaBrowser?: boolean
  canCollapseFolderSubtree?: boolean
  /** Collapse Folder only reads as an action while the folder is expanded. */
  isExpanded?: boolean
  canAddAsProject?: boolean
  /** Callers with their own Reveal affordance (scope member rows) suppress the duplicate. */
  showReveal?: boolean
  deleteShortcutLabel: string
  selectedPaths?: ReadonlySet<string>
  codeIntelligenceScope?: CodeIntelligenceScope | null
  onStartNew: (type: 'file' | 'folder', dir: string, depth: number) => void
  onStartRename: (node: TreeNode) => void
  onDuplicate: (node: TreeNode) => void
  onCopyPaths: (pathKind: 'absolute' | 'relative') => void
  onOpenInTerminal: () => void
  onViewFile: () => void
  onCollapseFolderSubtree: () => void
  onFindInFolder: () => void
  onRequestDelete: () => void
  onAddFolderAsProject?: () => void
  onToggleCodeIntelligenceMembers?: (paths: readonly string[], action: 'add' | 'remove') => void
}

/** The worktree file-tree context menu, shared with the Code scopes member tree (#81 parity). */
export function FileRowMenuItems({
  node,
  connectionId,
  selectionSize = 1,
  runtimeDownloadContext,
  supportsFolderDownload = false,
  canOpenInOrcaBrowser = false,
  canCollapseFolderSubtree = false,
  isExpanded = true,
  canAddAsProject = false,
  showReveal = true,
  deleteShortcutLabel,
  selectedPaths,
  codeIntelligenceScope = null,
  onStartNew,
  onStartRename,
  onDuplicate,
  onCopyPaths,
  onOpenInTerminal,
  onViewFile,
  onCollapseFolderSubtree,
  onFindInFolder,
  onRequestDelete,
  onAddFolderAsProject,
  onToggleCodeIntelligenceMembers
}: FileRowMenuItemsProps): React.JSX.Element {
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const copyPathShortcutLabel = useShortcutLabel('fileExplorer.copyPath')
  const copyRelativePathShortcutLabel = useShortcutLabel('fileExplorer.copyRelativePath')
  const findInFolderShortcutLabel = useShortcutLabel('sidebar.search.toggle')
  // New File/Folder targets follow the worktree tree's own derivation
  // (FileExplorerVirtualRows): a folder creates inside itself, a file beside itself.
  const targetDir = node.isDirectory ? node.path : dirname(node.path)
  const targetDepth = node.isDirectory ? node.depth + 1 : node.depth
  const showRemoteDownloadAction = shouldShowRemoteDownloadAction(
    node,
    connectionId,
    runtimeDownloadContext,
    supportsFolderDownload
  )
  const showCopyFileAction = shouldShowCopyFileAction(node, connectionId, selectionSize)
  const codeIntelligenceAction =
    codeIntelligenceScope && onToggleCodeIntelligenceMembers && node.isDirectory
      ? getCodeIntelligenceMembershipAction(codeIntelligenceScope, node.relativePath)
      : null
  const handleOpenInOrcaBrowser = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const result = openFileInBrowserTab({ filePath: node.path, worktreeId: activeWorktreeId })
    if (result.status === 'unsupported') {
      toast.error(result.message)
    }
  }, [activeWorktreeId, node.path])
  const handleDownload = useCallback(() => {
    const downloadTarget = connectionId || runtimeDownloadContext
    if (!downloadTarget) {
      return
    }
    void downloadRemoteFile(node, downloadTarget)
  }, [connectionId, node, runtimeDownloadContext])
  const handleCopyFile = useCallback(() => {
    void copyFileToOsClipboard(node, connectionId)
  }, [connectionId, node])
  const handleReveal = useCallback(() => {
    // Why: connectionId is a prop so folder-session trees inject the owning
    // repo's host instead of the store's active-worktree lookup.
    if (
      isLocalPathOpenBlocked(useAppStore.getState().settings, {
        connectionId: connectionId ?? null
      })
    ) {
      showLocalPathOpenBlockedToast()
      return
    }
    window.api.shell.openPath(node.path)
  }, [connectionId, node.path])

  return (
    <>
      <ContextMenuItem onSelect={() => onStartNew('file', targetDir, targetDepth)}>
        <FilePlus />
        {translate('auto.components.right.sidebar.FileExplorerRow.37c875d827', 'New File')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onStartNew('folder', targetDir, targetDepth)}>
        <FolderPlus />
        {translate('auto.components.right.sidebar.FileExplorerRow.f61af83316', 'New Folder')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {showCopyFileAction && (
        <ContextMenuItem onSelect={handleCopyFile}>
          <Copy />
          {translate('auto.components.right.sidebar.FileExplorerRow.98a79948b3', 'Copy')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onCopyPaths('absolute')}>
        <Copy />
        {selectionSize > 1
          ? translate('auto.components.right.sidebar.FileExplorerRow.f9d7ca753d', 'Copy Paths')
          : translate('auto.components.right.sidebar.FileExplorerRow.b5d436aa30', 'Copy Path')}
        {copyPathShortcutLabel !== 'Unassigned' ? (
          <ContextMenuShortcut>{copyPathShortcutLabel}</ContextMenuShortcut>
        ) : null}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCopyPaths('relative')}>
        <Copy />
        {selectionSize > 1
          ? translate(
              'auto.components.right.sidebar.FileExplorerRow.42e10cbf57',
              'Copy Relative Paths'
            )
          : translate(
              'auto.components.right.sidebar.FileExplorerRow.66a29dde82',
              'Copy Relative Path'
            )}
        {copyRelativePathShortcutLabel !== 'Unassigned' ? (
          <ContextMenuShortcut>{copyRelativePathShortcutLabel}</ContextMenuShortcut>
        ) : null}
      </ContextMenuItem>
      {!node.isDirectory && (
        <ContextMenuItem onSelect={() => onDuplicate(node)}>
          <Files />
          {translate('auto.components.right.sidebar.FileExplorerRow.0fec99bfd7', 'Duplicate')}
        </ContextMenuItem>
      )}
      {canAddAsProject && onAddFolderAsProject && (
        <ContextMenuItem onSelect={onAddFolderAsProject}>
          <FolderPlus />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.1bb9be455c',
            'Add as Project...'
          )}
        </ContextMenuItem>
      )}
      {codeIntelligenceAction === 'disabled' && (
        <ContextMenuItem disabled>
          {/* Why: leading Check instead of a shortcut chip — STYLEGUIDE reserves chips for real shortcuts. */}
          <Check />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.codeIntelligenceInScope',
            'In Code Intelligence'
          )}
        </ContextMenuItem>
      )}
      {(codeIntelligenceAction === 'add' || codeIntelligenceAction === 'remove') && (
        <ContextMenuItem
          onSelect={() =>
            onToggleCodeIntelligenceMembers!(
              getCodeIntelligenceMenuTargetPaths(node, selectedPaths ?? new Set()),
              codeIntelligenceAction
            )
          }
        >
          <Braces />
          {codeIntelligenceAction === 'remove'
            ? translate(
                'auto.components.right.sidebar.FileExplorerRow.codeIntelligenceRemove',
                'Remove from Code Intelligence'
              )
            : translate(
                'auto.components.right.sidebar.FileExplorerRow.codeIntelligenceAdd',
                'Add to Code Intelligence'
              )}
        </ContextMenuItem>
      )}
      {shouldShowOpenInTerminalAction(node) && (
        <ContextMenuItem onSelect={onOpenInTerminal}>
          <SquareTerminal />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.e887fa4b2e',
            'Open in Terminal'
          )}
        </ContextMenuItem>
      )}
      {shouldShowViewFileAction(node) && (
        <ContextMenuItem onSelect={onViewFile}>
          <File />
          {translate('auto.components.right.sidebar.FileExplorerRow.1d8e182c32', 'View File')}
        </ContextMenuItem>
      )}
      {!node.isDirectory && activeWorktreeId && canOpenInOrcaBrowser && (
        <ContextMenuItem onSelect={handleOpenInOrcaBrowser}>
          <Globe />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.dd112c81d2',
            'Open in Orca Browser'
          )}
        </ContextMenuItem>
      )}
      {!node.isDirectory && activeWorktreeId && detectLanguage(node.path) === 'markdown' && (
        <ContextMenuItem
          onSelect={() =>
            openMarkdownPreview({
              filePath: node.path,
              relativePath: node.relativePath,
              worktreeId: activeWorktreeId,
              language: 'markdown'
            })
          }
        >
          <Eye />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.d87a4c42e1',
            'Open Markdown Preview'
          )}
        </ContextMenuItem>
      )}
      {showRemoteDownloadAction && (
        <ContextMenuItem onSelect={handleDownload}>
          <Download />
          {node.isDirectory
            ? translate(
                'auto.components.right.sidebar.FileExplorerRow.7ac885bd2f',
                'Download Folder'
              )
            : translate('auto.components.right.sidebar.FileExplorerRow.c2112579f6', 'Download')}
        </ContextMenuItem>
      )}
      {canCollapseFolderSubtree && shouldShowCollapseFolderAction(node, isExpanded) && (
        <ContextMenuItem onSelect={onCollapseFolderSubtree}>
          <ListCollapse />
          {translate('auto.components.right.sidebar.FileExplorerRow.d6a25618aa', 'Collapse Folder')}
        </ContextMenuItem>
      )}
      {shouldShowFindInFolderAction(node) && (
        <ContextMenuItem onSelect={onFindInFolder}>
          <Search />
          {translate('auto.components.right.sidebar.FileExplorerRow.0df0e5abac', 'Find in Folder')}
          {findInFolderShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{findInFolderShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
      )}
      {showReveal && (
        <ContextMenuItem onSelect={handleReveal}>
          <ExternalLink />
          {revealLabel}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onStartRename(node)}>
        <Pencil />
        {translate('auto.components.right.sidebar.FileExplorerRow.fc747429bf', 'Rename')}
        <ContextMenuShortcut>
          {isMac
            ? '↩'
            : translate('auto.components.right.sidebar.FileExplorerRow.a06551beee', 'Enter')}
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onRequestDelete}>
        <Trash2 />
        {translate('auto.components.right.sidebar.FileExplorerRow.addc01145f', 'Delete')}
        <ContextMenuShortcut>{deleteShortcutLabel}</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  )
}
