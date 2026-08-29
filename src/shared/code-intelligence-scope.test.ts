import { describe, expect, it } from 'vitest'
import {
  getCodeIntelligenceScopeId,
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
