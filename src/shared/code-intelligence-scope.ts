import type { ExecutionHostId } from './execution-host'
import { getRepoExecutionHostId } from './execution-host'
import type { Repo } from './types'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from './cross-platform-path'

export type CodeIntelligenceLanguage = 'python' | 'cpp'

export function getCodeIntelligenceWorkspaceKey(
  repoId: string,
  isFolder: boolean
): CodeIntelligenceScope['workspaceKey'] {
  return isFolder ? `folder:${repoId}` : `worktree:${repoId}`
}

export function getCodeIntelligenceScopeId(args: {
  executionHostId: ExecutionHostId
  workspaceKey: CodeIntelligenceScope['workspaceKey']
  language: CodeIntelligenceLanguage
}): string {
  return `${encodeURIComponent(args.executionHostId)}:${args.workspaceKey}:${args.language}`
}

export function getCppScopeIdForRepo(
  repo: Pick<Repo, 'id' | 'kind' | 'connectionId' | 'executionHostId'>
): string {
  return getCodeIntelligenceScopeId({
    executionHostId: getRepoExecutionHostId(repo),
    workspaceKey: getCodeIntelligenceWorkspaceKey(repo.id, repo.kind === 'folder'),
    language: 'cpp'
  })
}
export type CodeIntelligenceServerSource =
  | { type: 'automatic' }
  | { type: 'managed'; version?: string }
  | { type: 'custom'; executable: string; args: string[] }
export type CodeIntelligenceScopeMember = { path: string; visibleResults: boolean }
export type CodeIntelligenceScopeConsent = { configurationFingerprint: string; grantedAt: number }
export type CodeIntelligenceProbeResult = {
  available: boolean
  version?: string
  message?: string
  installCommand?: string
}
export type CodeIntelligenceConfigurationMode = 'cmake' | 'gn' | 'basic' | 'mixed'
export type CodeIntelligenceSetupStatus = {
  state: 'ready' | 'limited' | 'error'
  mode: CodeIntelligenceConfigurationMode
  generatedAt: number
  compileCommandCount?: number
  warningCount?: number
  message?: string
  compileCommandsDir?: string
}
export type CodeIntelligenceScopeChange = {
  scopeId: string
  revision: number | null
  removed: boolean
}
export type CodeIntelligenceScope = {
  id: string
  name: string
  executionHostId: ExecutionHostId
  workspaceKey: `worktree:${string}` | `folder:${string}`
  workspaceRoot: string
  language: CodeIntelligenceLanguage
  members: CodeIntelligenceScopeMember[]
  serverSource: CodeIntelligenceServerSource
  consent?: CodeIntelligenceScopeConsent
  setupStatus?: CodeIntelligenceSetupStatus
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
type LegacyScopeMember = { path?: unknown; relativePath?: unknown }

function readScopeMemberPath(member: CodeIntelligenceScopeMember): string {
  const legacy = member as CodeIntelligenceScopeMember & LegacyScopeMember
  if (typeof legacy.path === 'string') {
    return legacy.path
  }
  // Pre-multi-folder settings stored members as {relativePath}; map them on read.
  if (typeof legacy.relativePath === 'string') {
    return legacy.relativePath
  }
  throw new Error('Code intelligence member requires a path')
}

export function hasLegacyCodeIntelligenceMembers(
  scope: Pick<CodeIntelligenceScope, 'members'>
): boolean {
  return (scope.members ?? []).some(
    (member) => typeof (member as LegacyScopeMember).path !== 'string'
  )
}

export function normalizeScopeMemberPath(value: string): string {
  const absolute = isRuntimePathAbsolute(value)
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized.startsWith('~')) {
    throw new Error(
      'Code intelligence member paths must not start with ~; pass the expanded Host path'
    )
  }
  if (!absolute && (!normalized || normalized === '.')) {
    return '.'
  }
  if (normalized.split('/').includes('..')) {
    throw new Error('Code intelligence member must stay inside its workspace')
  }
  if (absolute) {
    // Filesystem roots must stay absolute: '/' would collapse to the relative
    // '.', and a bare drive form would lose the separator that proves it absolute.
    const driveRoot = normalized.match(/^([A-Za-z]):$/)
    if (driveRoot) {
      return `${driveRoot[1]}:/`
    }
    return normalized || '/'
  }
  return normalized
}

export function normalizeCodeIntelligenceScope(
  scope: CodeIntelligenceScope
): CodeIntelligenceScope {
  const seen = new Set<string>(),
    members: CodeIntelligenceScopeMember[] = []
  for (const input of scope.members) {
    const path = normalizeScopeMemberPath(readScopeMemberPath(input))
    if (scope.language === 'python' && isRuntimePathAbsolute(path)) {
      throw new Error('Python code intelligence members must stay relative to the workspace')
    }
    // Directory-equivalence key: relative members resolve against the workspace
    // root; win32 drive/UNC forms fold case, posix stays exact. Nested members
    // deliberately survive — result visibility relies on longest-match semantics.
    const key = normalizeRuntimePathForComparison(
      isRuntimePathAbsolute(path) ? path : resolveRuntimePath(scope.workspaceRoot, path)
    )
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    members.push({ path, visibleResults: input.visibleResults })
  }
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
    workspaceRoot: scope.workspaceRoot,
    language: scope.language,
    members: scope.members,
    serverSource: scope.serverSource,
    enabled: scope.enabled
  }
}
