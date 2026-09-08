import type { ExecutionHostId } from './execution-host'
import { getRepoExecutionHostId } from './execution-host'
import type { Repo } from './types'
import type { LanguageServerKind } from './language-server-session'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from './cross-platform-path'

/** Python code intelligence is gone (#131); the wire kind union keeps
 * tolerating python kinds for mixed-version remote pairs. */
export type CodeIntelligenceLanguage = 'cpp'

/** The server a scope's language launches — clangd since python removal (#131). */
export function languageServerKindForScope(_language: CodeIntelligenceLanguage): LanguageServerKind {
  return 'clangd'
}

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
/** Per-scope BASIC synthesis options (#128): shared include directories, defines,
 * and C++ standard applied to every BASIC member. Empty options are omitted from
 * the scope entirely so legacy consents never go stale over a no-op field. */
export type CodeIntelligenceBasicOptions = {
  includeDirectories: string[]
  defines: string[]
  cppStandard?: 'c++17' | 'c++20' | 'c++23'
}
/** Absent `compileDatabase` = BASIC indexing (spec §2 Step 1); the host-absolute
 * path may live anywhere on the Host, unlike `path` which stays in-workspace. */
export type CodeIntelligenceScopeMember = {
  path: string
  visibleResults: boolean
  compileDatabase?: string
}
export type CodeIntelligenceScopeConsent = {
  configurationFingerprint: string
  grantedAt: number
  /** Member snapshot at authorization time; drives the re-consent banner diff. */
  authorizedMembers?: CodeIntelligenceScopeMember[]
  /** Canonical configuration snapshot at authorization time — renderer-side
   * staleness without node:crypto; absent on pre-snapshot consents. */
  authorizedConfiguration?: string
}
/** Scope configuration mode derived from members (#128): `basic` when every
 * member self-indexes, `mapped` when every member maps a supplied database,
 * `mixed` otherwise. */
export type CodeIntelligenceConfigurationMode = 'basic' | 'mapped' | 'mixed'
export function codeIntelligenceScopeConfigurationMode(
  scope: Pick<CodeIntelligenceScope, 'members'>
): CodeIntelligenceConfigurationMode {
  const hasMapped = scope.members.some((member) => member.compileDatabase !== undefined)
  if (!hasMapped) {
    return 'basic'
  }
  return scope.members.some((member) => member.compileDatabase === undefined) ? 'mixed' : 'mapped'
}
/** Ephemeral scope-snapshot change events; see CodeIntelligenceScopeStore. */
export type CodeIntelligenceScopeChange = {
  scopeId: string
  revision: number | null
  removed: boolean
  /** Ephemeral mapping health (#136 spec §2 Step 4): rides this push, never
   * persisted into settings — absent on ordinary scope changes. */
  mappingHealth?: readonly AggregateMappingHealthSnapshot[]
}

/** Per-mapping health as of the latest aggregate rebuild. */
export type AggregateMappingHealthSnapshot = {
  id: string
  memberPath: string
  compileDatabase: string
  state: 'ok' | 'degraded' | 'warning'
  failure?: 'not-found' | 'invalid-json' | 'invalid-shape' | 'no-in-folder-commands'
}

/** Workspace-level Configure Code save (#138): one row, one mode. */
export type CodeIntelligenceConfigureAggregateRequest = {
  repoId: string
  mode: 'cdb' | 'basic'
  /** Host-absolute; required in cdb mode. */
  compileDatabase?: string
  basicOptions?: CodeIntelligenceBasicOptions
}

export type CodeIntelligenceConfigureAggregateResult = {
  scope: CodeIntelligenceScope
  mappings: readonly AggregateMappingHealthSnapshot[]
  entryCount: number
}

export type CodeIntelligenceRevalidateAggregateResult = {
  mappings: readonly AggregateMappingHealthSnapshot[]
  entryCount: number
}
export type CodeIntelligenceScope = {
  id: string
  name: string
  executionHostId: ExecutionHostId
  workspaceKey: `worktree:${string}` | `folder:${string}`
  workspaceRoot: string
  language: CodeIntelligenceLanguage
  members: CodeIntelligenceScopeMember[]
  /** BASIC synthesis options shared by every member without a compileDatabase. */
  basicOptions?: CodeIntelligenceBasicOptions
  serverSource: CodeIntelligenceServerSource
  consent?: CodeIntelligenceScopeConsent
  /** Provenance: scopes born from the Outline's zero-config default (ADR 0003).
   * Metadata only — deliberately outside scopeConfigurationPayload so flipping
   * it never touches consent staleness. */
  origin?: 'outline-auto'
  /** Per-scope format-on-save (#20): off unless explicitly enabled; deliberately
   * outside scopeConfigurationPayload so flipping it never demands re-consent. */
  formatOnSave?: boolean
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

/** Host-absolute file path, may live anywhere on the Host (spec §2 Step 1). */
export function normalizeCompileDatabasePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('~')) {
    throw new Error(
      'Code intelligence compile database paths must not start with ~; pass the expanded Host path'
    )
  }
  if (!isRuntimePathAbsolute(normalized)) {
    throw new Error('Code intelligence compile database must be a Host-absolute path')
  }
  return normalized
}

/** Directory intersection on comparison keys — equal or nested either way. */
function comparisonKeysIntersect(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Empty options carry no meaning — dropping them keeps legacy scopes (and their
 * consents) byte-identical after normalization. */
function normalizeBasicOptions(
  options: CodeIntelligenceBasicOptions | undefined
): CodeIntelligenceBasicOptions | undefined {
  if (!options) {
    return undefined
  }
  const includeDirectories = options.includeDirectories.filter((directory) => directory !== '')
  const defines = options.defines.filter((define) => define !== '')
  if (includeDirectories.length === 0 && defines.length === 0 && !options.cppStandard) {
    return undefined
  }
  return {
    includeDirectories,
    defines,
    ...(options.cppStandard ? { cppStandard: options.cppStandard } : {})
  }
}

export function normalizeCodeIntelligenceScope(
  scope: CodeIntelligenceScope
): CodeIntelligenceScope {
  const seen = new Set<string>(),
    members: CodeIntelligenceScopeMember[] = []
  // Directory keys with their mapped flag — the overlap guard runs here, the
  // single normalization point every write path (upsert, migration, consent)
  // routes through.
  const configured: { key: string; mapped: boolean }[] = []
  for (const input of scope.members) {
    const path = normalizeScopeMemberPath(readScopeMemberPath(input))
    const compileDatabase =
      typeof input.compileDatabase === 'string'
        ? normalizeCompileDatabasePath(input.compileDatabase)
        : undefined
    // Directory-equivalence key: relative members resolve against the workspace
    // root; win32 drive/UNC forms fold case, posix stays exact.
    const key = normalizeRuntimePathForComparison(
      isRuntimePathAbsolute(path) ? path : resolveRuntimePath(scope.workspaceRoot, path)
    )
    if (seen.has(key)) {
      continue
    }
    // A mapped folder intersecting any other configured folder is rejected
    // (spec §1); only BASIC∩BASIC nesting survives, on longest-match.
    for (const entry of configured) {
      if (
        (compileDatabase !== undefined || entry.mapped) &&
        comparisonKeysIntersect(key, entry.key)
      ) {
        throw new Error(
          'Mapped code intelligence folders must not overlap other configured folders'
        )
      }
    }
    seen.add(key)
    configured.push({ key, mapped: compileDatabase !== undefined })
    members.push({ path, visibleResults: input.visibleResults, ...(compileDatabase ? { compileDatabase } : {}) })
  }
  // Empty member lists are legal (#63 decision 6): removing the last member
  // keeps the scope so consent history and kept-empty hints survive.
  if (!scope.id.trim() || !scope.name.trim()) {
    throw new Error('Code intelligence scope requires an id and name')
  }
  if (scope.serverSource.type === 'custom' && !scope.serverSource.executable.trim()) {
    throw new Error('Custom language server executable is required')
  }
  const basicOptions = normalizeBasicOptions(scope.basicOptions)
  const { basicOptions: _inputBasicOptions, ...rest } = scope
  return {
    ...rest,
    id: scope.id.trim(),
    name: scope.name.trim(),
    members,
    ...(basicOptions ? { basicOptions } : {})
  }
}
