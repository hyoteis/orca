import type { GlobalSettings } from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

export function getStatusBarCodeIntelligenceScopes(args: {
  settings: GlobalSettings | null | undefined
  activeWorktreeId: string | null
  executionHostId?: ExecutionHostId | null
}): CodeIntelligenceScope[] {
  if (!args.activeWorktreeId) {
    return []
  }
  const repoId = getRepoIdFromWorktreeId(args.activeWorktreeId)
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
  relativePath: string
): string {
  const root = scope.workspaceRoot.replace(/[\\/]+$/, '')
  return relativePath === '.' ? root : `${root}/${relativePath.replace(/^\.\/?/, '')}`
}
