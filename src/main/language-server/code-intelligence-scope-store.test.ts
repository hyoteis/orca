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

function createStore(
  initial: CodeIntelligenceScope[] = [],
  repoExecutionHostId = 'ssh:box',
  initialSettings: Partial<GlobalSettings> = {}
) {
  let settings = { codeIntelligenceScopes: initial, ...initialSettings } as GlobalSettings
  return {
    getRepos: vi.fn(() => [
      {
        id: 'w',
        path: '/workspace',
        displayName: 'Workspace',
        connectionId: 'box',
        executionHostId: repoExecutionHostId as CodeIntelligenceScope['executionHostId'],
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
  it('owns revisions and invalidates consent when configuration changes', async () => {
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
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 2 })
      ).rejects.toThrow('consent')
  })

  it('ignores payload key order when deciding whether configuration changed', () => {
    // Same configuration, different construction order on nested objects —
    // bare JSON.stringify would flag this as a change and burn a revision +
    // consent; the canonical serializer must not.
    const reordered = {
      ...scope(),
      members: [{ visibleResults: true, path: 'engine' }] as CodeIntelligenceScope['members'],
      serverSource: {
        args: ['--background-index'],
        executable: '/usr/bin/clangd',
        type: 'custom'
      } as CodeIntelligenceScope['serverSource']
    }
    const result = new CodeIntelligenceScopeStore(createStore([scope()])).upsert(reordered)
    expect(result.scope.revision).toBe(1)
    expect(result.restartRequired).toBe(false)
  })

  it('requires a session restart only for changes beyond members', async () => {
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

  it('restarts on a re-run setup without burning a revision or consent', () => {
    // Identical configuration, but the setup regenerated the compile database
    // the launch consumes — the session must restart; the consent chain must not.
    const result = new CodeIntelligenceScopeStore(createStore([scope()])).upsert({
      ...scope(),
      setupStatus: {
        state: 'ready',
        mode: 'cmake',
        generatedAt: 1234,
        compileCommandCount: 561,
        warningCount: 0,
        compileCommandsDir: 'C:/cache/scope'
      }
    })
    expect(result.restartRequired).toBe(true)
    expect(result.scope.revision).toBe(1)
  })

  it('keeps a member-emptied scope alive without a session restart', async () => {
    const store = createStore([scope()])
    const result = new CodeIntelligenceScopeStore(store).upsert({ ...scope(), members: [] })
    expect(result.restartRequired).toBe(false)
    expect(result.scope.members).toEqual([])
    expect(result.scope.revision).toBe(2)
    expect(store.getSettings().codeIntelligenceScopes).toHaveLength(1)
  })

  it('authorizes only the persisted enabled scope with current consent and revision', async () => {
    const store = createStore([scope()])
    const catalog = new CodeIntelligenceScopeStore(store)
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
      ).rejects.toThrow('consent')
    catalog.grantConsent('scope', 1)
    expect(
      await catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).toMatchObject({
      sessionId: 's',
      scopeId: 'scope',
      revision: 1,
      kind: 'clangd',
      workspaceRoot: '/workspace',
      executionHostId: 'ssh:box' as const,
      command: { executable: '/usr/bin/clangd', args: ['--background-index'] }
    })
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 2 })
      ).rejects.toThrow('revision')
  })

  it('rejects a renderer-supplied root outside the persisted workspace', async () => {
    const catalog = new CodeIntelligenceScopeStore(createStore())
    expect(() => catalog.upsert(scope({ workspaceRoot: '/other' }))).toThrow('does not match')
  })

  it('rejects disabled scopes even when they previously had consent', async () => {
    const store = createStore([scope({ enabled: false })])
    const catalog = new CodeIntelligenceScopeStore(store)
    catalog.grantConsent('scope', 1)
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
      ).rejects.toThrow('disabled')
  })

  it('lazily migrates legacy {relativePath} members on read and drops setupStatus', async () => {
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
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
      ).rejects.toThrow('consent')
  })

  it('blanks setupStatus on the one-shot model migration, then keeps new ones', async () => {
    const setupStatus: CodeIntelligenceScope['setupStatus'] = {
      state: 'ready',
      mode: 'cmake',
      generatedAt: 1
    }
    const store = createStore([scope({ setupStatus })])
    const catalog = new CodeIntelligenceScopeStore(store)

    // #128 spec §2 Step 1: the first read blanks legacy setupStatus and arms the
    // one-time upgrade notice.
    expect(catalog.list()[0].setupStatus).toBeUndefined()
    expect(store.getSettings().codeIntelligenceModelUpgradeNoticePending).toBe(true)

    // After the migration ran, a freshly generated setupStatus survives reads.
    store.updateSettings({
      codeIntelligenceScopes: [scope({ setupStatus })],
      codeIntelligenceModelUpgradeNoticePending: false
    })
    store.updateSettings.mockClear()
    expect(catalog.list()[0].setupStatus).toEqual(setupStatus)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('round-trips a scope with mixed relative and absolute members', async () => {
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

  it('invalidates a consent fingerprint granted over the legacy member shape', async () => {
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

    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
      ).rejects.toThrow('consent')
  })

  it('resolves managed sources through the Host launch resolver', async () => {
    const managed = scope({ serverSource: { type: 'managed', version: '22.1.6' } })
    const catalog = new CodeIntelligenceScopeStore(
      createStore([managed]),
      async () => ({ executable: '/managed/clangd/22.1.6/bin/clangd', args: [] })
    )
    catalog.grantConsent('scope', 1)

    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).resolves.toMatchObject({
      kind: 'clangd',
      command: { executable: '/managed/clangd/22.1.6/bin/clangd', args: [] },
      managed: { tool: 'clangd', version: '22.1.6' }
    })
  })

  it('refuses managed sources with no active install outside Runtime Hosts', async () => {
    const managed = scope({ serverSource: { type: 'managed' } })
    const catalog = new CodeIntelligenceScopeStore(createStore([managed]))
    catalog.grantConsent('scope', 1)

    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).rejects.toThrow('No managed clangd version is active')
  })

  it('lets Runtime Hosts resolve managed launches server-side', async () => {
    const managed = scope({
      serverSource: { type: 'managed' },
      executionHostId: 'runtime:env' as const
    })
    const catalog = new CodeIntelligenceScopeStore(
      createStore([managed], 'runtime:env')
    )
    catalog.grantConsent('scope', 1)

    const launch = await catalog.authorizeSession({
      sessionId: 's',
      scopeId: 'scope',
      revision: 1
    })
    expect(launch.command).toBeUndefined()
    expect(launch.managed).toEqual({ tool: 'clangd' })
  })
})

describe('one-shot mapped-model migration (#128 spec §2 Step 1)', () => {
  it('drops python scopes, keeps cpp consents byte-identically, and arms the notice once', () => {
    const consent = {
      configurationFingerprint: 'f',
      grantedAt: 1,
      authorizedMembers: [{ path: 'engine', visibleResults: true }]
    }
    const cpp = scope({ consent })
    const python = scope({
      id: 'ssh%3Abox:folder:w:python',
      language: 'python',
      members: [{ path: 'scripts', visibleResults: true }]
    })
    const store = createStore(
      [cpp, python],
      'ssh:box',
      {
        codeIntelligenceDeclinedAutoScopes: ['ssh%3Abox:folder:w:python', 'ssh%3Abox:folder:w:cpp']
      }
    )
    const catalog = new CodeIntelligenceScopeStore(store)

    const scopes = catalog.list()

    expect(scopes.map((entry) => entry.id)).toEqual(['scope'])
    // Zero-rewrite: the cpp member bytes and consent survive untouched.
    expect(JSON.stringify(store.getSettings().codeIntelligenceScopes![0])).toBe(
      JSON.stringify({ ...cpp, consent })
    )
    // Python declisions prune; cpp declisions keep blocking auto-recreation.
    expect(store.getSettings().codeIntelligenceDeclinedAutoScopes).toEqual([
      'ssh%3Abox:folder:w:cpp'
    ])
    expect(store.getSettings().codeIntelligenceModelUpgradeNoticePending).toBe(true)
    expect(store.updateSettings).toHaveBeenCalledTimes(1)

    // Second read: already migrated, nothing further persists.
    store.updateSettings.mockClear()
    catalog.list()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('rejects a pre-migration python scope at authorizeSession', async () => {
    const store = createStore([
      scope({ language: 'python', members: [{ path: 'scripts', visibleResults: true }] })
    ])
    // Simulate the window before list()'s migration persists: raw settings keep
    // the python scope, so the launch path itself must refuse it explicitly.
    store.updateSettings = vi.fn()
    const catalog = new CodeIntelligenceScopeStore(store)
    await expect(
      catalog.authorizeSession({ sessionId: 's', scopeId: 'scope', revision: 1 })
    ).rejects.toThrow('Python code intelligence is no longer supported')
  })

  it('persists mapped members and derived options through upsert', () => {
    const catalog = new CodeIntelligenceScopeStore(createStore())
    const { scope: saved } = catalog.upsert(
      scope({
        members: [
          { path: 'engine', visibleResults: true, compileDatabase: '/b/cdb.json' },
          { path: 'third_party', visibleResults: true }
        ],
        basicOptions: { includeDirectories: ['/opt/sdk/include'], defines: ['USE_GPU=1'] }
      })
    )
    expect(saved.members[0].compileDatabase).toBe('/b/cdb.json')
    expect(saved.basicOptions).toEqual({
      includeDirectories: ['/opt/sdk/include'],
      defines: ['USE_GPU=1']
    })
    // Adding a disjoint member is a plain configuration change: revision moves.
    expect(
      catalog.upsert(scope({ ...saved, members: [...saved.members, { path: 'tools', visibleResults: true }] }))
        .scope.revision
    ).toBe(2)
    // The overlap guard fires through upsert too.
    expect(() =>
      catalog.upsert(
        scope({
          members: [
            { path: 'engine', visibleResults: true, compileDatabase: '/b/cdb.json' },
            { path: 'engine/sub', visibleResults: true }
          ]
        })
      )
    ).toThrow('overlap')
  })
})

describe('declined-auto-scope pruning (#130)', () => {
  it('prunes orphaned python declisions without arming the notice', () => {
    const store = createStore(
      [scope()],
      'ssh:box',
      { codeIntelligenceDeclinedAutoScopes: ['ssh%3Abox:folder:w:python'] }
    )
    const catalog = new CodeIntelligenceScopeStore(store)
    expect(catalog.list()).toHaveLength(1)
    expect(store.getSettings().codeIntelligenceDeclinedAutoScopes).toEqual([])
    // No python scope was dropped, so no upgrade notice is owed.
    expect(store.getSettings().codeIntelligenceModelUpgradeNoticePending).toBeUndefined()
  })
})
