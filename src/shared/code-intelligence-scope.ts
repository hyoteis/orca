import type { ExecutionHostId } from './execution-host'

export type CodeIntelligenceLanguage = 'python' | 'cpp'
export type CodeIntelligenceServerSource =
  | { type: 'automatic' }
  | { type: 'managed'; version?: string }
  | { type: 'custom'; executable: string; args: string[] }
export type CodeIntelligenceScopeMember = { relativePath: string; visibleResults: boolean }
export type CodeIntelligenceScopeConsent = { configurationFingerprint: string; grantedAt: number }
export type CodeIntelligenceScope = {
  id: string
  name: string
  executionHostId: ExecutionHostId
  workspaceKey: `worktree:${string}` | `folder:${string}`
  language: CodeIntelligenceLanguage
  members: CodeIntelligenceScopeMember[]
  serverSource: CodeIntelligenceServerSource
  consent?: CodeIntelligenceScopeConsent
  enabled: boolean
  revision: number
}

export function normalizeScopeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized === '.') {
    return '.'
  }
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Code intelligence member must stay inside its workspace')
  }
  return normalized
}
export function normalizeCodeIntelligenceScope(
  scope: CodeIntelligenceScope
): CodeIntelligenceScope {
  const seen = new Set<string>(),
    members = scope.members
      .map((member) => ({
        ...member,
        relativePath: normalizeScopeRelativePath(member.relativePath)
      }))
      .filter((member) => {
        const key = member.relativePath.toLowerCase()
        if (seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
  if (!scope.id.trim() || !scope.name.trim() || members.length === 0) {
    throw new Error('Code intelligence scope requires an id, name, and member')
  }
  if (scope.serverSource.type === 'custom' && !scope.serverSource.executable.trim()) {
    throw new Error('Custom language server executable is required')
  }
  return { ...scope, id: scope.id.trim(), name: scope.name.trim(), members }
}
export function scopeConfigurationPayload(scope: CodeIntelligenceScope): unknown {
  return {
    executionHostId: scope.executionHostId,
    workspaceKey: scope.workspaceKey,
    language: scope.language,
    members: scope.members,
    serverSource: scope.serverSource,
    enabled: scope.enabled
  }
}
