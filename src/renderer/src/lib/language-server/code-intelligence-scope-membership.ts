import {
  isRuntimePathAbsolute,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import type {
  CodeIntelligenceScope,
  CodeIntelligenceScopeMember
} from '../../../../shared/code-intelligence-scope'

export type CodeIntelligenceMemberScope = {
  workspaceRoot: CodeIntelligenceScope['workspaceRoot']
  members: readonly CodeIntelligenceScopeMember[]
}

function normalizeCandidatePath(value: string): string | null {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
  if (/^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    return null
  }
  return normalized || '.'
}

export function memberWorkspaceRelativePath(
  scope: CodeIntelligenceMemberScope,
  member: CodeIntelligenceScopeMember
): string | null {
  if (!isRuntimePathAbsolute(member.path)) {
    return member.path
  }
  // Absolute members only govern workspace documents when they sit under the
  // workspace root; members elsewhere on the Host never match workspace files.
  const inside = relativePathInsideRoot(scope.workspaceRoot, member.path)
  return inside === null ? null : inside || '.'
}

function pathContains(memberPath: string, relativePath: string): boolean {
  return (
    memberPath === '.' || relativePath === memberPath || relativePath.startsWith(`${memberPath}/`)
  )
}

export function isDocumentInCodeIntelligenceScope(
  scope: CodeIntelligenceMemberScope,
  relativePath: string
): boolean {
  const normalized = normalizeCandidatePath(relativePath)
  if (normalized === null) {
    return false
  }
  return scope.members.some((member) => {
    const memberPath = memberWorkspaceRelativePath(scope, member)
    return memberPath !== null && pathContains(memberPath, normalized)
  })
}

export function isCodeIntelligenceResultVisible(
  scope: CodeIntelligenceMemberScope,
  relativePath: string
): boolean {
  const normalized = normalizeCandidatePath(relativePath)
  if (normalized === null) {
    return false
  }
  let mostSpecificPath: string | null = null
  let visibleResults = false
  for (const member of scope.members) {
    const memberPath = memberWorkspaceRelativePath(scope, member)
    if (memberPath === null || !pathContains(memberPath, normalized)) {
      continue
    }
    if (mostSpecificPath === null || memberPath.length > mostSpecificPath.length) {
      mostSpecificPath = memberPath
      visibleResults = member.visibleResults
    }
  }
  return visibleResults
}

/** Three-state tree-menu rule: exact member → 'remove', strict subpath → 'disabled', else 'add'. */
export type CodeIntelligenceMembershipAction = 'add' | 'remove' | 'disabled'

export function getCodeIntelligenceMembershipAction(
  scope: CodeIntelligenceMemberScope,
  relativePath: string
): CodeIntelligenceMembershipAction {
  const normalized = normalizeCandidatePath(relativePath)
  if (normalized === null) {
    return 'disabled'
  }
  let contains = false
  for (const member of scope.members) {
    const memberPath = memberWorkspaceRelativePath(scope, member)
    if (memberPath === null || !pathContains(memberPath, normalized)) {
      continue
    }
    if (memberPath === normalized) {
      return 'remove'
    }
    contains = true
  }
  return contains ? 'disabled' : 'add'
}
