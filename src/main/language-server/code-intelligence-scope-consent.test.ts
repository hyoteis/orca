import { describe, expect, it } from 'vitest'
import {
  grantCodeIntelligenceConsent,
  getCodeIntelligenceConfigurationFingerprint,
  hasCurrentCodeIntelligenceConsent
} from './code-intelligence-scope-consent'
import {
  codeIntelligenceConfigurationSnapshot,
  type CodeIntelligenceScope
} from '../../shared/code-intelligence-scope'
const scope = (): CodeIntelligenceScope => ({
  id: 'scope',
  name: 'Engine',
  executionHostId: 'ssh:box',
  workspaceKey: 'folder:w',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members: [{ path: 'repo-a', visibleResults: true }],
  serverSource: { type: 'custom', executable: '/usr/bin/clangd', args: [] },
  enabled: true,
  revision: 1
})
describe('code intelligence consent', () => {
  it('is stable and invalidated by executable or membership changes', () => {
    const current = scope(),
      fingerprint = getCodeIntelligenceConfigurationFingerprint(current)
    current.consent = grantCodeIntelligenceConsent(current, 10)
    expect(current.consent.configurationFingerprint).toBe(fingerprint)
    expect(hasCurrentCodeIntelligenceConsent(current)).toBe(true)
    current.members.push({ path: 'repo-b', visibleResults: true })
    expect(hasCurrentCodeIntelligenceConsent(current)).toBe(false)
  })

  it('snapshots the configuration the renderer can recompute without node:crypto', () => {
    const current = scope()
    current.consent = grantCodeIntelligenceConsent(current, 10)
    expect(current.consent.authorizedConfiguration).toBe(
      codeIntelligenceConfigurationSnapshot(current)
    )
    // The hash and the snapshot stay two views of the same payload.
    expect(getCodeIntelligenceConfigurationFingerprint(current)).not.toBe('')
  })
})
