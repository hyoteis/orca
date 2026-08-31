import { createHash } from 'node:crypto'
import {
  normalizeCodeIntelligenceScope,
  scopeConfigurationPayload,
  type CodeIntelligenceScope,
  type CodeIntelligenceScopeConsent
} from '../../shared/code-intelligence-scope'
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
export function getCodeIntelligenceConfigurationFingerprint(scope: CodeIntelligenceScope): string {
  return createHash('sha256')
    .update(canonical(scopeConfigurationPayload(normalizeCodeIntelligenceScope(scope))))
    .digest('hex')
}
export function grantCodeIntelligenceConsent(
  scope: CodeIntelligenceScope,
  now = Date.now()
): CodeIntelligenceScopeConsent {
  return {
    configurationFingerprint: getCodeIntelligenceConfigurationFingerprint(scope),
    grantedAt: now,
    // Snapshot the normalized members so the renderer's diff uses the same
    // shape the fingerprint hashes.
    authorizedMembers: structuredClone(normalizeCodeIntelligenceScope(scope).members)
  }
}
export function hasCurrentCodeIntelligenceConsent(scope: CodeIntelligenceScope): boolean {
  return (
    scope.consent?.configurationFingerprint === getCodeIntelligenceConfigurationFingerprint(scope)
  )
}
