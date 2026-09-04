import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import type { CodeIntelligenceScopeMember } from '../../../../shared/code-intelligence-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceEditBlockedTarget,
  WorkspaceEditBlockReason,
  WorkspaceEditScopeRef
} from '../../../../shared/language-server-workspace-edit'

/** Scope members may be absolute Host paths or workspace-relative fragments. */
export function memberEditBoundaryPath(
  scope: Pick<WorkspaceEditScopeRef, 'workspaceRoot' | 'members'>,
  member: CodeIntelligenceScopeMember
): string {
  const path = isRuntimePathAbsolute(member.path)
    ? member.path
    : resolveRuntimePath(scope.workspaceRoot, member.path)
  return path.replace(/\\/g, '/')
}

/** Scope/Host/path authorization (#20): an edit may only touch files inside a
 * consented member of the scope, executed by the scope's own host. */
export function authorizeWorkspaceEditTargets(args: {
  scope: Pick<WorkspaceEditScopeRef, 'executionHostId' | 'workspaceRoot' | 'members'>
  operationHostId: ExecutionHostId
  targets: readonly { uri: string; hostPath: string }[]
}): { blocks: WorkspaceEditBlockedTarget[] } {
  const blocks: WorkspaceEditBlockedTarget[] = []
  const boundaries = args.scope.members.map((member) =>
    memberEditBoundaryPath(args.scope, member)
  )
  for (const target of args.targets) {
    const reason = targetBlockReason({
      uri: target.uri,
      hostPath: target.hostPath,
      operationHostId: args.operationHostId,
      scopeHostId: args.scope.executionHostId,
      boundaries
    })
    if (reason !== null) {
      blocks.push({ uri: target.uri, hostPath: target.hostPath, reason })
    }
  }
  return { blocks }
}

function targetBlockReason(args: {
  uri: string
  hostPath: string
  operationHostId: ExecutionHostId
  scopeHostId: ExecutionHostId
  boundaries: readonly string[]
}): WorkspaceEditBlockReason | null {
  if (!args.uri.startsWith('file:')) {
    return 'non-file-uri'
  }
  if (args.operationHostId !== args.scopeHostId) {
    return 'host-mismatch'
  }
  const normalized = args.hostPath.replace(/\\/g, '/')
  const inScope = args.boundaries.some((boundary) => isPathInsideOrEqual(boundary, normalized))
  return inScope ? null : 'out-of-scope'
}
