import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type { CodeIntelligenceScope } from '../../shared/code-intelligence-scope'
import { CodeIntelligenceScopeStore } from './code-intelligence-scope-store'

const scope = (overrides: Partial<CodeIntelligenceScope> = {}): CodeIntelligenceScope => ({
  id: 'scope',
  name: 'Engine',
  executionHostId: 'ssh:box' as const,
  workspaceKey: 'folder:w',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members: [{ relativePath: 'engine', visibleResults: true }],
  serverSource: { type: 'custom', executable: '/usr/bin/clangd', args: ['--background-index'] },
  enabled: true,
  revision: 1,
  ...overrides
})

function createStore(initial: CodeIntelligenceScope[] = []) {
  let settings = { codeIntelligenceScopes: initial } as GlobalSettings
  return {
    getRepos: vi.fn(() => [
      {
        id: 'w',
        path: '/workspace',
        displayName: 'Workspace',
        connectionId: 'box',
        executionHostId: 'ssh:box' as const,
        kind: 'folder' as const,
        badgeColor: '#000000',
        addedAt: 1
      }
    ]),
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

describe('CodeIntelligenceScopeStore', () => {
  it('owns revisions and invalidates consent when configuration changes', () => {
    const persisted = scope()
    const store = createStore([persisted])
    const catalog = new CodeIntelligenceScopeStore(store)
    const granted = catalog.grantConsent('scope', 1, 10)
    expect(granted.consent?.grantedAt).toBe(10)

    const result = catalog.upsert({
      ...granted,
      members: [{ relativePath: 'src', visibleResults: true }]
    })
    expect(result.restartRequired).toBe(true)
    expect(result.scope.revision).toBe(2)
    expect(result.scope.consent).toBeUndefined()
  })

  it('authorizes only the persisted enabled scope with current consent and revision', () => {
    const store = createStore([scope()])
    const catalog = new CodeIntelligenceScopeStore(store)
    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toThrow('consent')
    catalog.grantConsent('scope', 1)
    expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toMatchObject({
      sessionId: 's',
      scopeId: 'scope',
      revision: 1,
      kind: 'clangd',
      workspaceRoot: '/workspace',
      executionHostId: 'ssh:box' as const,
      command: { executable: '/usr/bin/clangd', args: ['--background-index'] }
    })
    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 2 })
    ).toThrow('revision')
  })

  it('rejects a renderer-supplied root outside the persisted workspace', () => {
    const catalog = new CodeIntelligenceScopeStore(createStore())
    expect(() => catalog.upsert(scope({ workspaceRoot: '/other' }))).toThrow('does not match')
  })

  it('rejects disabled scopes even when they previously had consent', () => {
    const store = createStore([scope({ enabled: false })])
    const catalog = new CodeIntelligenceScopeStore(store)
    catalog.grantConsent('scope', 1)
    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toThrow('disabled')
  })
})
