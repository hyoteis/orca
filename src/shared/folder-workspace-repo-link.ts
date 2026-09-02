import type { ExecutionHostId } from './execution-host'
import { getRepoExecutionHostId, toSshExecutionHostId } from './execution-host'
import type { FolderWorkspace, Repo } from './types'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { isFolderRepo } from './repo-kind'

export function getFolderWorkspaceExecutionHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  return (
    folderWorkspace.executionHostId ??
    (folderWorkspace.connectionId ? toSshExecutionHostId(folderWorkspace.connectionId) : 'local')
  )
}

/** #72 variant A: a folder workspace reads/writes the same-path folder repo's scopes. */
export function findFolderWorkspaceLinkedRepo(
  folderWorkspace: Pick<
    FolderWorkspace,
    'folderPath' | 'connectionId' | 'executionHostId'
  >,
  repos: readonly Repo[]
): Repo | null {
  const hostId = getFolderWorkspaceExecutionHostId(folderWorkspace)
  const target = normalizeRuntimePathForComparison(folderWorkspace.folderPath)
  return (
    repos.find(
      (repo) =>
        isFolderRepo(repo) &&
        getRepoExecutionHostId(repo) === hostId &&
        normalizeRuntimePathForComparison(repo.path) === target
    ) ?? null
  )
}
