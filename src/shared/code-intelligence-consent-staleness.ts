import {
  normalizeCodeIntelligenceScope,
  type CodeIntelligenceScope
} from './code-intelligence-scope'

/** Ordered member compare — mirrors the fingerprint's members coverage, so the
 * banner and authorizeSession agree on when consent went stale. Consents with
 * an authorizedConfiguration snapshot compare the whole payload instead, so
 * fingerprint-only drift (serverSource, workspaceRoot) still lights the UI. */
export function isCodeIntelligenceConsentStale(scope: CodeIntelligenceScope): boolean {
  if (!scope.consent) {
    return false
  }
  if (scope.consent.authorizedConfiguration !== undefined) {
    return scope.consent.authorizedConfiguration !== codeIntelligenceConfigurationSnapshot(scope)
  }
  return JSON.stringify(scope.consent.authorizedMembers) !== JSON.stringify(scope.members)
}

/** Symmetric difference of member paths since authorization (0 = config-only change). */
export function countChangedCodeIntelligenceMembers(
  scope: Pick<CodeIntelligenceScope, 'members' | 'consent'>
): number {
  // A snapshot-less consent (pre-upgrade data) has no diff to count; the banner
  // falls back to its configuration-changed line instead of guessing.
  if (!scope.consent?.authorizedMembers) {
    return 0
  }
  const before = new Set(scope.consent.authorizedMembers.map((member) => member.path))
  const after = new Set(scope.members.map((member) => member.path))
  let changed = 0
  for (const path of before) {
    if (!after.has(path)) {
      changed++
    }
  }
  for (const path of after) {
    if (!before.has(path)) {
      changed++
    }
  }
  return changed
}

export function scopeConfigurationPayload(scope: CodeIntelligenceScope): unknown {
  return {
    executionHostId: scope.executionHostId,
    workspaceKey: scope.workspaceKey,
    workspaceRoot: scope.workspaceRoot,
    language: scope.language,
    members: scope.members,
    ...(scope.basicOptions ? { basicOptions: scope.basicOptions } : {}),
    serverSource: scope.serverSource,
    enabled: scope.enabled
  }
}

/** Key-sorted canonical JSON — one serialization both the Host-side hash and
 * the renderer-side staleness compare agree on. */
export function canonicalConfigurationJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfigurationJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalConfigurationJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What `configurationFingerprint` hashes — comparable verbatim in the renderer. */
export function codeIntelligenceConfigurationSnapshot(scope: CodeIntelligenceScope): string {
  return canonicalConfigurationJson(
    scopeConfigurationPayload(normalizeCodeIntelligenceScope(scope))
  )
}
