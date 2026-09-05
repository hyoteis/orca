import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-client'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const EMPTY_IGNORED_PATHS: readonly string[] = []

export type IgnoredPathResult = {
  activeWorktreeId: string
  paths: string[]
  worktreePath: string
}

export function getEffectiveFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  ignoredPathResult,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  ignoredPathResult: IgnoredPathResult | null
  worktreePath: string | null
}): readonly string[] {
  const ignoredPathResultMatchesCurrentWorktree =
    ignoredPathResult !== null &&
    ignoredPathResult.activeWorktreeId === activeWorktreeId &&
    ignoredPathResult.worktreePath === worktreePath

  if (!canLoadIgnoredPaths || !ignoredPathResultMatchesCurrentWorktree) {
    return EMPTY_IGNORED_PATHS
  }

  // Why: expanding folders changes the query before the async ignored refresh returns.
  // Keep same-worktree answers so known ignored rows do not flash as normal text.
  return ignoredPathResult.paths
}

export function useFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  relativePaths,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  relativePaths: readonly string[]
  worktreePath: string | null
}): readonly string[] {
  const [ignoredPathResult, setIgnoredPathResult] = useState<IgnoredPathResult | null>(null)

  useEffect(() => {
    if (!canLoadIgnoredPaths || !activeWorktreeId || !worktreePath) {
      return
    }

    let canceled = false
    const refresh = (): void => {
      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      void getRuntimeGitIgnoredPaths(
        {
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        [...relativePaths]
      )
        .then((paths) => {
          if (!canceled) {
            setIgnoredPathResult({ activeWorktreeId, paths, worktreePath })
          }
        })
        .catch(() => {
          if (!canceled) {
            setIgnoredPathResult({ activeWorktreeId, paths: [], worktreePath })
          }
        })
    }
    refresh()

    return () => {
      canceled = true
    }
  }, [activeWorktreeId, canLoadIgnoredPaths, relativePaths, worktreePath])

  return getEffectiveFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    ignoredPathResult,
    worktreePath
  })
}
