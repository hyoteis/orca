const REMOTE_FOLDER_DOWNLOAD_PARENT_KEY = 'orca.remote-folder-download-parent'

function downloadDestinationStorage(): Storage | null {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export function getRememberedRemoteFolderDownloadParent(): string | undefined {
  try {
    return downloadDestinationStorage()?.getItem(REMOTE_FOLDER_DOWNLOAD_PARENT_KEY) || undefined
  } catch {
    return undefined
  }
}

export function rememberRemoteFolderDownloadParent(path: string): void {
  if (!path) {
    return
  }
  try {
    downloadDestinationStorage()?.setItem(REMOTE_FOLDER_DOWNLOAD_PARENT_KEY, path)
  } catch {
    // Download success must not be downgraded by an unavailable renderer preference store.
  }
}
