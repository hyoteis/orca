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
  let repoId = getRepoIdFromWorktreeId(args.activeWorktreeId)
  // Why: folder sessions have no repo of their own — their scopes are the
  // same-path folder repo's (#72 variant A), so bridge before key matching.
  if (parseWorkspaceKey(args.activeWorktreeId)?.type === 'folder') {
    const workspace =
      args.folderWorkspaces?.find(
        (candidate) => folderWorkspaceKey(candidate.id) === args.activeWorktreeId
      ) ?? null
    const linked =
      workspace && args.repos ? findFolderWorkspaceLinkedRepo(workspace, args.repos) : null
    if (!linked) {
      return []
    }
    repoId = linked.id
  }
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
