import { createHash } from 'node:crypto'
import {
  codeIntelligenceConfigurationSnapshot,
  normalizeCodeIntelligenceScope,
  type CodeIntelligenceScope,
  type CodeIntelligenceScopeConsent
} from '../../shared/code-intelligence-scope'
function fingerprintOfSnapshot(snapshot: string): string {
  return createHash('sha256').update(snapshot).digest('hex')
}
export function getCodeIntelligenceConfigurationFingerprint(scope: CodeIntelligenceScope): string {
  return fingerprintOfSnapshot(codeIntelligenceConfigurationSnapshot(scope))
}
export function grantCodeIntelligenceConsent(
  scope: CodeIntelligenceScope,
  now = Date.now()
): CodeIntelligenceScopeConsent {
  // normalize is idempotent, so snapshotting the normalized scope skips a re-run.
  const normalized = normalizeCodeIntelligenceScope(scope)
  const authorizedConfiguration = codeIntelligenceConfigurationSnapshot(normalized)
  return {
    configurationFingerprint: fingerprintOfSnapshot(authorizedConfiguration),
    grantedAt: now,
    authorizedMembers: structuredClone(normalized.members),
    authorizedConfiguration
  }
}
export function hasCurrentCodeIntelligenceConsent(scope: CodeIntelligenceScope): boolean {
  return (
    scope.consent?.configurationFingerprint === getCodeIntelligenceConfigurationFingerprint(scope)
  )
}
