import type { CodeIntelligenceScopeMember } from '../../../../shared/code-intelligence-scope'

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

function memberContains(member: CodeIntelligenceScopeMember, relativePath: string): boolean {
  return (
    member.relativePath === '.' ||
    relativePath === member.relativePath ||
    relativePath.startsWith(`${member.relativePath}/`)
  )
}

export function isDocumentInCodeIntelligenceScope(
  scope: { members: readonly CodeIntelligenceScopeMember[] },
  relativePath: string
): boolean {
  const normalized = normalizeCandidatePath(relativePath)
  return normalized !== null && scope.members.some((member) => memberContains(member, normalized))
}

export function isCodeIntelligenceResultVisible(
  scope: { members: readonly CodeIntelligenceScopeMember[] },
  relativePath: string
): boolean {
  const normalized = normalizeCandidatePath(relativePath)
  if (normalized === null) {
    return false
  }
  let mostSpecific: CodeIntelligenceScopeMember | null = null
  for (const member of scope.members) {
    if (
      memberContains(member, normalized) &&
      (!mostSpecific || member.relativePath.length > mostSpecific.relativePath.length)
    ) {
      mostSpecific = member
    }
  }
  return mostSpecific?.visibleResults ?? false
}
