import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  getRememberedRemoteFolderDownloadParent,
  rememberRemoteFolderDownloadParent
} from '@/lib/remote-folder-download-destination'
import { downloadRuntimeFile, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { TreeNode } from './file-explorer-types'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
export const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

export function shouldShowCollapseFolderAction(node: TreeNode, isExpanded: boolean): boolean {
  return node.isDirectory && isExpanded
}

export function shouldShowFindInFolderAction(node: TreeNode): boolean {
  return node.isDirectory
}

export function shouldShowOpenInTerminalAction(node: TreeNode): boolean {
  return node.isDirectory
}

export function shouldShowViewFileAction(node: TreeNode): boolean {
  return !node.isDirectory
}

export function shouldShowRemoteDownloadAction(
  node: TreeNode,
  connectionId?: string | null,
  runtimeDownloadContext?: RuntimeFileOperationArgs | null,
  // Why: fail closed — only show folder download when the connection explicitly
  // advertises SFTP recursive transfer (system-SSH and unknown states stay off).
  supportsFolderDownload = false
): boolean {
  // Why: Desktop-only because download depends on Electron's native save/folder dialogs;
  // runtime and system-SSH folders have no recursive transfer contract.
  const hasDownloadCapability = node.isDirectory
    ? Boolean(connectionId && supportsFolderDownload)
    : Boolean(connectionId || runtimeDownloadContext)
  return (
    hasDownloadCapability &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

export function shouldShowCopyFileAction(
  node: TreeNode,
  connectionId?: string | null,
  selectionSize = 1
): boolean {
  // Why: remote directories would require recursive materialization semantics;
  // keep this to a single concrete file reference until multi-file copy exists.
  return (
    (!connectionId || !node.isDirectory) &&
    selectionSize === 1 &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

function getLocalDownloadParent(
  destinationPath: string,
  platform: NodeJS.Platform
): string | undefined {
  const separatorIndex =
    platform === 'win32'
      ? Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'))
      : destinationPath.lastIndexOf('/')
  if (separatorIndex < 0) {
    return undefined
  }
  if (separatorIndex === 0) {
    return destinationPath.slice(0, 1)
  }
  const parent = destinationPath.slice(0, separatorIndex)
  return platform === 'win32' && /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

function getLocalDownloadName(destinationPath: string, platform: NodeJS.Platform): string {
  const lastSeparatorIndex =
    platform === 'win32'
      ? Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'))
      : destinationPath.lastIndexOf('/')
  return destinationPath.slice(lastSeparatorIndex + 1)
}

export async function downloadRemoteFile(
  node: TreeNode,
  connectionIdOrRuntimeContext: string | RuntimeFileOperationArgs
): Promise<void> {
  try {
    const rememberedDownloadParent = node.isDirectory
      ? getRememberedRemoteFolderDownloadParent()
      : undefined
    const result =
      typeof connectionIdOrRuntimeContext === 'string'
        ? node.isDirectory
          ? await window.api.fs.downloadFolder({
              dirPath: node.path,
              connectionId: connectionIdOrRuntimeContext,
              ...(rememberedDownloadParent ? { defaultPath: rememberedDownloadParent } : {})
            })
          : await window.api.fs.downloadFile({
              filePath: node.path,
              connectionId: connectionIdOrRuntimeContext
            })
        : await downloadRuntimeFile(connectionIdOrRuntimeContext, node.path, node.name)
    // Why: Suppress toasts when the user cancels the native save dialog per design.
    if (result.canceled) {
      return
    }
    // Why: POSIX permits backslashes in saved names; only Windows treats them as separators.
    const platform = window.api.platform.get().platform
    const savedName = getLocalDownloadName(result.destinationPath, platform)
    if (node.isDirectory) {
      const destinationParent = getLocalDownloadParent(result.destinationPath, platform)
      if (destinationParent) {
        rememberRemoteFolderDownloadParent(destinationParent)
      }
    }
    toast.success(
      node.isDirectory
        ? translate(
            'auto.components.right.sidebar.FileExplorerRow.a4029c996b',
            "Downloaded folder '{{value0}}'",
            { value0: savedName }
          )
        : translate(
            'auto.components.right.sidebar.FileExplorerRow.bce4d4e44f',
            "Downloaded '{{value0}}'",
            { value0: savedName }
          ),
      {
        action: {
          label: translate('auto.components.right.sidebar.FileExplorerRow.1a3df04ae1', 'Open'),
          onClick: () => {
            void window.api.shell.openPath(result.destinationPath)
          }
        }
      }
    )
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        node.isDirectory
          ? translate(
              'auto.components.right.sidebar.FileExplorerRow.f729bcd97d',
              "Failed to download folder '{{value0}}'.",
              { value0: node.name }
            )
          : translate(
              'auto.components.right.sidebar.FileExplorerRow.b3e288bf41',
              "Failed to download '{{value0}}'.",
              { value0: node.name }
            )
      )
    )
  }
}

export async function copyFileToOsClipboard(
  node: TreeNode,
  connectionId?: string | null
): Promise<void> {
  const failureMessage = translate(
    'auto.components.right.sidebar.FileExplorerRow.b234ab25b4',
    'Could not copy the file to the clipboard'
  )
  const stagingFailureMessage = translate(
    'auto.components.right.sidebar.FileExplorerRow.clipboardStagingUnavailable',
    "Could not copy the file because Orca's temporary storage is unavailable"
  )
  try {
    const result = await window.api.ui.writeClipboardFile(
      connectionId ? { filePath: node.path, connectionId } : node.path
    )
    if (!result.ok) {
      toast.error(result.reason === 'staging-unavailable' ? stagingFailureMessage : failureMessage)
    }
  } catch (error) {
    toast.error(extractIpcErrorMessage(error, failureMessage))
  }
}
