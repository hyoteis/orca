import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
  members: [{ path: 'engine', visibleResults: true }],
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
    expect(granted.consent?.authorizedMembers).toEqual([{ path: 'engine', visibleResults: true }])

    const result = catalog.upsert({
      ...granted,
      members: [{ path: 'src', visibleResults: true }]
    })
    // Member-only change (spec §5): the clangd session must NOT restart — the
    // atomic CDB rewrite is picked up lazily — but revision and consent still
    // move so the trust chain has no member-change bypass.
    expect(result.restartRequired).toBe(false)
    expect(result.scope.revision).toBe(2)
    // The stale consent survives so surfaces can diff against its member snapshot;
    // its fingerprint no longer matches, so authorizeSession still refuses it.
    expect(result.scope.consent?.authorizedMembers).toEqual([
      { path: 'engine', visibleResults: true }
    ])
    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 2 })
    ).toThrow('consent')
  })

  it('requires a session restart only for changes beyond members', () => {
    const upsert = (next: CodeIntelligenceScope): boolean =>
      new CodeIntelligenceScopeStore(createStore([scope()])).upsert(next).restartRequired
    expect(upsert({ ...scope(), enabled: false })).toBe(true)
    expect(
      upsert({
        ...scope(),
        serverSource: { type: 'custom', executable: '/opt/clangd', args: [] }
      })
    ).toBe(true)
    // Visibility-only member edits are still member-only: no restart.
    expect(
      upsert({ ...scope(), members: [{ path: 'engine', visibleResults: false }] })
    ).toBe(false)
  })

  it('keeps a member-emptied scope alive without a session restart', () => {
    const store = createStore([scope()])
    const result = new CodeIntelligenceScopeStore(store).upsert({ ...scope(), members: [] })
    expect(result.restartRequired).toBe(false)
    expect(result.scope.members).toEqual([])
    expect(result.scope.revision).toBe(2)
    expect(store.getSettings().codeIntelligenceScopes).toHaveLength(1)
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

  it('lazily migrates legacy {relativePath} members on read and drops setupStatus', () => {
    const setupStatus: CodeIntelligenceScope['setupStatus'] = {
      state: 'ready',
      mode: 'cmake',
      generatedAt: 1
    }
    const legacy = {
      ...scope(),
      members: [
        { relativePath: 'engine', visibleResults: true }
      ] as unknown as CodeIntelligenceScope['members'],
      setupStatus,
      consent: { configurationFingerprint: 'stale', grantedAt: 1 }
    } as CodeIntelligenceScope
    const store = createStore([legacy])
    const catalog = new CodeIntelligenceScopeStore(store)

    const scopes = catalog.list()

    expect(scopes[0].members).toEqual([{ path: 'engine', visibleResults: true }])
    expect(scopes[0].setupStatus).toBeUndefined()
    // Migration persists the new shape so later reads never re-migrate.
    const persisted = store.getSettings().codeIntelligenceScopes
    expect(persisted?.[0].members).toEqual([{ path: 'engine', visibleResults: true }])
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
    // The stale fingerprint no longer matches, so consent must be re-granted.
    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toThrow('consent')
  })

  it('keeps setupStatus for scopes that already use {path} members', () => {
    const setupStatus: CodeIntelligenceScope['setupStatus'] = {
      state: 'ready',
      mode: 'cmake',
      generatedAt: 1
    }
    const store = createStore([scope({ setupStatus })])
    const catalog = new CodeIntelligenceScopeStore(store)

    expect(catalog.list()[0].setupStatus).toEqual(setupStatus)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('round-trips a scope with mixed relative and absolute members', () => {
    const catalog = new CodeIntelligenceScopeStore(createStore())
    const mixed = scope({
      members: [
        { path: 'engine', visibleResults: true },
        { path: '/opt/sdk/include', visibleResults: true }
      ]
    })
    const { scope: saved } = catalog.upsert(mixed)
    expect(saved.members).toEqual(mixed.members)
    expect(catalog.list()[0].members).toEqual(mixed.members)
  })

  it('invalidates a consent fingerprint granted over the legacy member shape', () => {
    // A pre-upgrade fingerprint hashed the payload with the {relativePath} key
    // (canonical() from the shipped code-intelligence-scope-consent.ts), so
    // rebuild that value to prove migration — not a hand-picked stale string —
    // is what breaks consent.
    const legacyPayload = {
      executionHostId: 'ssh:box',
      workspaceKey: 'folder:w',
      workspaceRoot: '/workspace',
      language: 'cpp',
      members: [{ relativePath: 'engine', visibleResults: true }],
      serverSource: { type: 'custom', executable: '/usr/bin/clangd', args: ['--background-index'] },
      enabled: true
    }
    const canonical = (value: unknown): string => {
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
    const preUpgradeFingerprint = createHash('sha256')
      .update(canonical(legacyPayload))
      .digest('hex')
    const legacy = {
      ...scope(),
      members: [
        { relativePath: 'engine', visibleResults: true }
      ] as unknown as CodeIntelligenceScope['members'],
      consent: { configurationFingerprint: preUpgradeFingerprint, grantedAt: 1 }
    } as CodeIntelligenceScope
    const catalog = new CodeIntelligenceScopeStore(createStore([legacy]))

    expect(() =>
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toThrow('consent')
  })
})
