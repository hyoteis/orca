import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { isDotfileRelativePath } from './file-explorer-entries'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { buildIgnoredSet, isPathIgnored } from './status-display'
import { useFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'

const EMPTY_RELATIVE_PATHS: string[] = []

type VisibleFileExplorerRowProjectionInput = {
  dirCache: Record<string, DirCache>
  expanded: Set<string>
  worktreePath: string | null
}

export function getFileExplorerIgnoredQueryRelativePaths(
  input: VisibleFileExplorerRowProjectionInput,
  showDotfiles: boolean
): string[] {
  const { dirCache, expanded, worktreePath } = input
  if (!worktreePath) {
    return []
  }

  const relativePaths: string[] = []
  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (!showDotfiles && isDotfileRelativePath(row.relativePath)) {
        continue
      }
      relativePaths.push(row.relativePath)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  visitChildren(worktreePath)
  return relativePaths
}

export function createVisibleFileExplorerRowProjection(
  input: VisibleFileExplorerRowProjectionInput,
  options: {
    ignoredSet: Set<string>
    showDotfiles: boolean
    showGitIgnoredFiles: boolean
  }
): FileExplorerRowProjection {
  const { dirCache, expanded, worktreePath } = input
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  if (!worktreePath) {
    return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  }

  const shouldHideRow = (row: TreeNode): boolean => {
    if (!options.showDotfiles && isDotfileRelativePath(row.relativePath)) {
      return true
    }
    return !options.showGitIgnoredFiles && isPathIgnored(options.ignoredSet, row.relativePath)
  }

  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (shouldHideRow(row)) {
        continue
      }
      visibleFlatRows.push(row)
      rowsByPath.set(row.path, row)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  visitChildren(worktreePath)

  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

/**
 * Holds the array identity while its contents are unchanged.
 *
 * Why: a tree refresh commits dirCache once per read wave, and every commit
 * rebuilds this list. Each new identity would re-issue the uncancellable git
 * check-ignore over the whole visible tree — the remote round trips the wave cap
 * exists to bound.
 */
function useContentStableRelativePaths(relativePaths: string[]): string[] {
  // Why: NUL cannot occur in paths, so the signature can reconstruct the list losslessly.
  const signature = useMemo(() => relativePaths.join('\u0000'), [relativePaths])
  const stableTreePaths = useMemo(
    () => (signature ? signature.split('\u0000') : EMPTY_RELATIVE_PATHS),
    [signature]
  )
  return stableTreePaths
}

export function useFileExplorerVisibleRowProjection(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  dirCache: Record<string, DirCache>,
  expanded: Set<string>,
  activeRepoSupportsGit: boolean,
  showDotfiles: boolean
): {
  rowProjection: FileExplorerRowProjection
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  toggleGitIgnoredFiles: () => void
} {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true
  const rebuiltRelativePaths = useMemo(
    () =>
      activeRepoSupportsGit
        ? getFileExplorerIgnoredQueryRelativePaths(
            { dirCache, expanded, worktreePath },
            showDotfiles
          )
        : EMPTY_RELATIVE_PATHS,
    [activeRepoSupportsGit, dirCache, expanded, showDotfiles, worktreePath]
  )
  const relativePaths = useContentStableRelativePaths(rebuiltRelativePaths)
  const canLoadIgnoredPaths =
    activeRepoSupportsGit &&
    Boolean(activeWorktreeId) &&
    Boolean(worktreePath) &&
    relativePaths.length > 0
  const effectiveIgnoredPaths = useFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths,
    worktreePath
  })
  const ignoredSet = useMemo(() => buildIgnoredSet(effectiveIgnoredPaths), [effectiveIgnoredPaths])
  const rowProjection = useMemo(
    () =>
      createVisibleFileExplorerRowProjection(
        { dirCache, expanded, worktreePath },
        {
          ignoredSet,
          showDotfiles,
          showGitIgnoredFiles
        }
      ),
    [dirCache, expanded, ignoredSet, showDotfiles, showGitIgnoredFiles, worktreePath]
  )
  const ignoredByRelativePath = useMemo(
    () => (showGitIgnoredFiles ? ignoredSet : new Set<string>()),
    [ignoredSet, showGitIgnoredFiles]
  )
  const toggleGitIgnoredFiles = useCallback(() => {
    void updateSettings({ showGitIgnoredFiles: !showGitIgnoredFiles })
  }, [showGitIgnoredFiles, updateSettings])

  return {
    rowProjection,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    toggleGitIgnoredFiles
  }
}
