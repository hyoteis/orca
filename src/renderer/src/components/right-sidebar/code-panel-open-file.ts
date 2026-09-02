import { toast } from 'sonner'
import { detectLanguage } from '@/lib/language-detect'
import { getRelativePathInsideRoot } from '@/lib/path'
import { useAppStore } from '@/store'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOperationRoute,
  getFileExplorerOwnerUnresolvedMessage
} from './file-explorer-operation-owner'

/** Mirrors activateFileExplorerNode's open: preview + focus, runtime owner from the route. */
export function openCodePanelFile(args: {
  filePath: string
  fileName: string
  activeWorktreeId: string
  workspaceRootPath: string
}): void {
  const route = getFileExplorerOperationRoute(
    getFileExplorerOperationOwner(args.activeWorktreeId)
  )
  if (!route) {
    toast.error(getFileExplorerOwnerUnresolvedMessage())
    return
  }
  const runtimeEnvironmentId = route.settings.activeRuntimeEnvironmentId?.trim() || null
  useAppStore.getState().openFile(
    {
      filePath: args.filePath,
      relativePath:
        getRelativePathInsideRoot(args.filePath, args.workspaceRootPath) ?? args.filePath,
      worktreeId: args.activeWorktreeId,
      runtimeEnvironmentId: runtimeEnvironmentId ?? undefined,
      language: detectLanguage(args.fileName),
      mode: 'edit'
    },
    {
      preview: true,
      focusEditor: true,
      suppressActiveRuntimeFallback: runtimeEnvironmentId === null
    }
  )
}
