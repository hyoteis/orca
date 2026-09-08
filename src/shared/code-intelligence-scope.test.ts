import { describe, expect, it } from 'vitest'
import {
  codeIntelligenceConfigurationSnapshot,
  codeIntelligenceScopeConfigurationMode,
  countChangedCodeIntelligenceMembers,
  getCodeIntelligenceScopeId,
  isCodeIntelligenceConsentStale,
  getCppScopeIdForRepo,
  normalizeCodeIntelligenceScope,
  type CodeIntelligenceScope
} from './code-intelligence-scope'

const scope = (overrides: Partial<CodeIntelligenceScope> = {}): CodeIntelligenceScope => ({
  id: 'scope',
  name: 'Engine',
  executionHostId: 'ssh:box',
  workspaceKey: 'folder:w',
  workspaceRoot: '/workspace',
  language: 'cpp',
  members: [{ path: 'engine', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1,
  ...overrides
})

const legacyMember = (path: string): unknown => ({ relativePath: path, visibleResults: true })

describe('normalizeCodeIntelligenceScope member forms', () => {
  it('accepts posix and win32 absolute members alongside relative ones', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [
          { path: '/opt/sdk/include', visibleResults: true },
          { path: 'engine', visibleResults: true },
          { path: 'D:\\External\\Lib\\', visibleResults: false }
        ]
      })
    )
    expect(normalized.members).toEqual([
      { path: '/opt/sdk/include', visibleResults: true },
      { path: 'engine', visibleResults: true },
      { path: 'D:/External/Lib', visibleResults: false }
    ])
  })

  it('keeps a scope whose members were all removed (#63 decision 6)', () => {
    expect(normalizeCodeIntelligenceScope(scope({ members: [] })).members).toEqual([])
  })

  it('rejects .. segments in both forms', () => {
    expect(() =>
      normalizeCodeIntelligenceScope(
        scope({ members: [{ path: '../secret', visibleResults: true }] })
      )
    ).toThrow('stay inside')
    expect(() =>
      normalizeCodeIntelligenceScope(
        scope({ members: [{ path: '/opt/../etc', visibleResults: true }] })
      )
    ).toThrow('stay inside')
  })

  it('rejects ~ paths instead of expanding them', () => {
    expect(() =>
      normalizeCodeIntelligenceScope(scope({ members: [{ path: '~/sdk', visibleResults: true }] }))
    ).toThrow('~')
    expect(() =>
      normalizeCodeIntelligenceScope(scope({ members: [{ path: '~', visibleResults: true }] }))
    ).toThrow('~')
  })

  it('rejects absolute members for python scopes', () => {
    expect(() =>
      normalizeCodeIntelligenceScope(
        scope({ language: 'python', members: [{ path: '/opt/py', visibleResults: true }] })
      )
    ).toThrow('Python')
    expect(
      normalizeCodeIntelligenceScope(
        scope({ language: 'python', members: [{ path: 'pkg', visibleResults: true }] })
      ).members
    ).toEqual([{ path: 'pkg', visibleResults: true }])
  })

  it('maps legacy {relativePath} members to {path}', () => {
    const normalized = normalizeCodeIntelligenceScope({
      ...scope(),
      members: [legacyMember('engine')] as CodeIntelligenceScope['members']
    })
    expect(normalized.members).toEqual([{ path: 'engine', visibleResults: true }])
  })

  it('keeps filesystem-root members absolute', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({ members: [{ path: '/', visibleResults: true }] })
    )
    expect(normalized.members).toEqual([{ path: '/', visibleResults: true }])
    const drive = normalizeCodeIntelligenceScope(
      scope({
        workspaceRoot: 'D:\\ws',
        members: [{ path: 'D:\\', visibleResults: true }]
      })
    )
    expect(drive.members).toEqual([{ path: 'D:/', visibleResults: true }])
    expect(() =>
      normalizeCodeIntelligenceScope(
        scope({ language: 'python', members: [{ path: '/', visibleResults: true }] })
      )
    ).toThrow('Python')
  })
})

describe('normalizeCodeIntelligenceScope member dedup', () => {
  it('dedupes a relative member against an equivalent absolute member, keeping the first', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [
          { path: '/workspace/engine', visibleResults: false },
          { path: 'engine', visibleResults: true }
        ]
      })
    )
    expect(normalized.members).toEqual([{ path: '/workspace/engine', visibleResults: false }])
  })

  it('dedupes win32 drive-form members case-insensitively', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        workspaceRoot: 'D:\\ws',
        members: [
          { path: 'Engine', visibleResults: true },
          { path: 'd:/WS/engine', visibleResults: true }
        ]
      })
    )
    expect(normalized.members).toEqual([{ path: 'Engine', visibleResults: true }])
  })

  it('keeps posix members that differ only by case', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [
          { path: '/workspace/Src', visibleResults: true },
          { path: 'src', visibleResults: true }
        ]
      })
    )
    expect(normalized.members).toHaveLength(2)
  })

  it('keeps nested members without parent-child dedup', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [
          { path: 'engine', visibleResults: true },
          { path: 'engine/core', visibleResults: true }
        ]
      })
    )
    expect(normalized.members).toHaveLength(2)
  })
})

describe('getCodeIntelligenceScopeId', () => {
  it('encodes the execution Host so the id stays free of path separators', () => {
    expect(
      getCodeIntelligenceScopeId({
        executionHostId: 'ssh:user@host:2222',
        workspaceKey: 'worktree:repo-1',
        language: 'cpp'
      })
    ).toBe('ssh%3Auser%40host%3A2222:worktree:repo-1:cpp')
  })
})

describe('getCppScopeIdForRepo', () => {
  it('derives the deterministic cpp scope id for git and folder workspaces', () => {
    expect(
      getCppScopeIdForRepo({ id: 'repo-1', executionHostId: 'local', kind: 'git' })
    ).toBe('local:worktree:repo-1:cpp')
    expect(
      getCppScopeIdForRepo({ id: 'folder-1', executionHostId: 'local', kind: 'folder' })
    ).toBe('local:folder:folder-1:cpp')
  })
})

describe('consent staleness', () => {
  const authorized = (members: CodeIntelligenceScope['members']): CodeIntelligenceScope =>
    scope({
      members,
      consent: {
        configurationFingerprint: 'irrelevant-to-diff',
        grantedAt: 1,
        authorizedMembers: [
          { path: 'engine', visibleResults: true },
          { path: 'fx', visibleResults: true }
        ]
      }
    })

  it('is current when authorized members match exactly', () => {
    const current = authorized([
      { path: 'engine', visibleResults: true },
      { path: 'fx', visibleResults: true }
    ])
    expect(isCodeIntelligenceConsentStale(current)).toBe(false)
    expect(countChangedCodeIntelligenceMembers(current)).toBe(0)
  })

  it('is stale after additions and removals, counting the symmetric difference', () => {
    const stale = authorized([
      { path: 'engine', visibleResults: true },
      { path: 'audio', visibleResults: true }
    ])
    expect(isCodeIntelligenceConsentStale(stale)).toBe(true)
    expect(countChangedCodeIntelligenceMembers(stale)).toBe(2)
  })

  it('is stale after a visibility-only change while counting zero folders', () => {
    const stale = authorized([
      { path: 'engine', visibleResults: true },
      { path: 'fx', visibleResults: false }
    ])
    expect(isCodeIntelligenceConsentStale(stale)).toBe(true)
    expect(countChangedCodeIntelligenceMembers(stale)).toBe(0)
  })

  it('treats missing consent as not stale and a snapshot-less consent as stale', () => {
    expect(isCodeIntelligenceConsentStale(scope())).toBe(false)
    expect(
      isCodeIntelligenceConsentStale(
        scope({
          members: [{ path: 'engine', visibleResults: true }],
          consent: { configurationFingerprint: 'f', grantedAt: 1 }
        })
      )
    ).toBe(true)
    // A pre-upgrade consent has no diff to count; the banner falls back to its
    // configuration-changed line rather than reporting every member as new.
    expect(
      countChangedCodeIntelligenceMembers(
        scope({ consent: { configurationFingerprint: 'f', grantedAt: 1 } })
      )
    ).toBe(0)
    expect(countChangedCodeIntelligenceMembers(scope({ consent: undefined }))).toBe(0)
  })
})

describe('consent staleness with authorizedConfiguration snapshot', () => {
  const consented = (overrides: Partial<CodeIntelligenceScope>): CodeIntelligenceScope => {
    const granted = scope({ serverSource: { type: 'automatic' } })
    return scope({
      consent: {
        configurationFingerprint: 'f',
        grantedAt: 1,
        authorizedMembers: granted.members,
        authorizedConfiguration: codeIntelligenceConfigurationSnapshot(granted)
      },
      ...overrides
    })
  }

  it('stays current while the configuration snapshot matches', () => {
    const current = consented({ serverSource: { type: 'automatic' } })
    expect(isCodeIntelligenceConsentStale(current)).toBe(false)
  })

  it('flags a serverSource change the members-only compare misses', () => {
    const current = consented({
      serverSource: { type: 'custom', executable: '/usr/bin/clangd', args: [] }
    })
    expect(isCodeIntelligenceConsentStale(current)).toBe(true)
    // Config-only drift: the banner shows its configuration-changed line, not a folder count.
    expect(countChangedCodeIntelligenceMembers(current)).toBe(0)
  })

  it('flags a workspaceRoot move and an enabled flip with identical members', () => {
    expect(isCodeIntelligenceConsentStale(consented({ workspaceRoot: '/moved' }))).toBe(true)
    expect(isCodeIntelligenceConsentStale(consented({ enabled: false }))).toBe(true)
  })

  it('still flags member changes through the snapshot', () => {
    const current = consented({
      members: [
        { path: 'engine', visibleResults: true },
        { path: 'fx', visibleResults: true }
      ]
    })
    expect(isCodeIntelligenceConsentStale(current)).toBe(true)
    expect(countChangedCodeIntelligenceMembers(current)).toBe(1)
  })

  it('keeps the members compare for legacy consents without a snapshot', () => {
    const legacy = scope({
      consent: {
        configurationFingerprint: 'f',
        grantedAt: 1,
        authorizedMembers: [{ path: 'engine', visibleResults: true }]
      },
      serverSource: { type: 'custom', executable: '/usr/bin/clangd', args: [] }
    })
    // Members identical, serverSource drifted — legacy data cannot tell; unchanged behavior.
    expect(isCodeIntelligenceConsentStale(legacy)).toBe(false)
  })
})

describe('mapped compile databases (#128 spec §2 Step 1)', () => {
  const mapped = (path: string, database: string) => ({
    path,
    visibleResults: true,
    compileDatabase: database
  })

  it('normalizes compile database paths through the member policy', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [mapped('engine', '/home/me/build/compile_commands.json/')]
      })
    )
    expect(normalized.members[0].compileDatabase).toBe(
      '/home/me/build/compile_commands.json'
    )
    expect(() =>
      normalizeCodeIntelligenceScope(scope({ members: [mapped('engine', '~/cdb.json')] }))
    ).toThrow('~')
    expect(() =>
      normalizeCodeIntelligenceScope(scope({ members: [mapped('engine', 'build/cdb.json')] }))
    ).toThrow('Host-absolute')
    expect(
      normalizeCodeIntelligenceScope(
        scope({ members: [mapped('engine', 'D:\\b\\compile_commands.json')] })
      ).members[0].compileDatabase
    ).toBe('D:/b/compile_commands.json')
  })

  it('rejects a mapped folder intersecting any other configured folder', () => {
    const cases: CodeIntelligenceScope['members'][] = [
      // mapped ∩ basic, either nesting direction
      [mapped('engine', '/b/cdb.json'), { path: 'engine/src', visibleResults: true }],
      [{ path: 'engine/src', visibleResults: true }, mapped('engine', '/b/cdb.json')],
      // mapped ∩ mapped
      [mapped('engine', '/a/cdb.json'), mapped('engine/tests', '/b/cdb.json')]
    ]
    for (const members of cases) {
      expect(() => normalizeCodeIntelligenceScope(scope({ members }))).toThrow('overlap')
    }
    // win32 drive workspaces fold case into one comparison key
    expect(() =>
      normalizeCodeIntelligenceScope(
        scope({
          workspaceRoot: 'C:\\workspace',
          members: [mapped('engine', '/b/cdb.json'), { path: 'Engine\\sub', visibleResults: true }]
        })
      )
    ).toThrow('overlap')
  })

  it('keeps BASIC∩BASIC nesting on longest-match and allows disjoint mapped folders', () => {
    const normalized = normalizeCodeIntelligenceScope(
      scope({
        members: [
          { path: 'engine', visibleResults: true },
          { path: 'engine/src', visibleResults: false },
          mapped('third_party', '/cdb/vendor.json'),
          mapped('tools', '/cdb/tools.json')
        ]
      })
    )
    expect(normalized.members).toHaveLength(4)
  })

  it('derives the scope configuration mode from members', () => {
    expect(
      codeIntelligenceScopeConfigurationMode(
        scope({ members: [{ path: 'engine', visibleResults: true }] })
      )
    ).toBe('basic')
    expect(
      codeIntelligenceScopeConfigurationMode(scope({ members: [mapped('a', '/c.json')] }))
    ).toBe('mapped')
    expect(
      codeIntelligenceScopeConfigurationMode(
        scope({
          members: [mapped('a', '/c.json'), { path: 'b', visibleResults: true }]
        })
      )
    ).toBe('mixed')
  })

  it('round-trips legacy members byte-identically without explicit edit', () => {
    const legacy = scope()
    const normalized = normalizeCodeIntelligenceScope(legacy)
    expect(JSON.stringify(normalized.members)).toBe(
      JSON.stringify(legacy.members)
    )
    expect('compileDatabase' in normalized.members[0]).toBe(false)
    // No basicOptions key materializes for a scope that never had any.
    expect('basicOptions' in normalized).toBe(false)
    expect(codeIntelligenceConfigurationSnapshot(legacy)).toBe(
      codeIntelligenceConfigurationSnapshot(normalized)
    )
  })

  it('omits empty basicOptions and joins non-empty ones into the consent payload', () => {
    const emptied = normalizeCodeIntelligenceScope(
      scope({ basicOptions: { includeDirectories: [], defines: [''] } })
    )
    expect('basicOptions' in emptied).toBe(false)
    expect(codeIntelligenceConfigurationSnapshot(emptied)).toBe(
      codeIntelligenceConfigurationSnapshot(scope())
    )
    const filled = normalizeCodeIntelligenceScope(
      scope({
        basicOptions: { includeDirectories: ['/opt/sdk/include'], defines: [] }
      })
    )
    expect(filled.basicOptions).toEqual({
      includeDirectories: ['/opt/sdk/include'],
      defines: []
    })
    // Editing BASIC options is a configuration change: consent must go stale.
    expect(codeIntelligenceConfigurationSnapshot(filled)).not.toBe(
      codeIntelligenceConfigurationSnapshot(scope())
    )
  })
})
