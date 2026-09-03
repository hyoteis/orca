import type { FolderWorkspace, GlobalSettings, Repo } from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { findFolderWorkspaceLinkedRepo } from '../../../../shared/folder-workspace-repo-link'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isRuntimePathAbsolute } from '../../../../shared/cross-platform-path'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeMember
} from '../../../../shared/code-intelligence-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

/** Folder-workspace bridging (#72 A): the same-path folder repo whose scopes a
 * folder:<uuid> session reads and writes. Null for worktree sessions. */
export function findSessionLinkedFolderRepo(args: {
  activeWorktreeId: string | null
  folderWorkspaces?: readonly FolderWorkspace[]
  repos?: readonly Repo[]
}): Repo | null {
  if (!args.activeWorktreeId || parseWorkspaceKey(args.activeWorktreeId)?.type !== 'folder') {
    return null
  }
  const workspace =
    args.folderWorkspaces?.find(
      (candidate) => folderWorkspaceKey(candidate.id) === args.activeWorktreeId
    ) ?? null
  return workspace && args.repos ? findFolderWorkspaceLinkedRepo(workspace, args.repos) : null
}

export function getStatusBarCodeIntelligenceScopes(args: {
  settings: GlobalSettings | null | undefined
  activeWorktreeId: string | null
  executionHostId?: ExecutionHostId | null
  /** Folder-workspace bridging (#72 A): resolve folder:<uuid> sessions to the linked folder repo. */
  folderWorkspaces?: readonly FolderWorkspace[]
  repos?: readonly Repo[]
}): CodeIntelligenceScope[] {
  if (!args.activeWorktreeId) {
    return []
  }
  // Why: folder sessions have no repo of their own — their scopes are the
  // same-path folder repo's (#72 variant A), so bridge before key matching.
  const linked = findSessionLinkedFolderRepo(args)
  if (!linked && parseWorkspaceKey(args.activeWorktreeId)?.type === 'folder') {
    return []
  }
  return scopesForRepo(args, linked?.id ?? getRepoIdFromWorktreeId(args.activeWorktreeId))
}

function scopesForRepo(
  args: {
    settings: GlobalSettings | null | undefined
    executionHostId?: ExecutionHostId | null
  },
  repoId: string
): CodeIntelligenceScope[] {
  const workspaceKeys = new Set([`worktree:${repoId}`, `folder:${repoId}`])
  return (args.settings?.codeIntelligenceScopes ?? []).filter(
    (scope) =>
      scope.enabled &&
      workspaceKeys.has(scope.workspaceKey) &&
      (!args.executionHostId || scope.executionHostId === args.executionHostId)
  )
}

export function countCodeIntelligenceScopeFolders(
  scopes: readonly CodeIntelligenceScope[]
): number {
  return scopes.reduce((count, scope) => count + scope.members.length, 0)
}

export function getCodeIntelligenceMemberDisplayPath(
  scope: Pick<CodeIntelligenceScope, 'workspaceRoot'>,
  member: CodeIntelligenceScopeMember
): string {
  if (isRuntimePathAbsolute(member.path)) {
    return member.path
  }
  const root = scope.workspaceRoot.replace(/[\\/]+$/, '')
  return member.path === '.' ? root : `${root}/${member.path.replace(/^\.\/?/, '')}`
}
