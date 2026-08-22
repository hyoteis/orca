import { describe, expect, it } from 'vitest'
import {
  grantCodeIntelligenceConsent,
  getCodeIntelligenceConfigurationFingerprint,
  hasCurrentCodeIntelligenceConsent
} from './code-intelligence-scope-consent'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
const scope = (): CodeIntelligenceScope => ({
  id: 'scope',
  name: 'Engine',
  executionHostId: 'ssh:box',
  workspaceKey: 'folder:w',
  language: 'cpp',
  members: [{ relativePath: 'repo-a', visibleResults: true }],
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
    current.members.push({ relativePath: 'repo-b', visibleResults: true })
    expect(hasCurrentCodeIntelligenceConsent(current)).toBe(false)
  })
})
