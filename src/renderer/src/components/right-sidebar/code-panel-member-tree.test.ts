import { describe, expect, it } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  buildCodePanelMemberRows,
  getCodePanelKeptEmptyLanguages,
  resolveCodePanelMemberDirectory
} from './code-panel-member-tree'

function scope(overrides: Partial<CodeIntelligenceScope>): CodeIntelligenceScope {
  return {
    id: 'local:worktree:repo-1:cpp',
    name: 'repo-1',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/ws/repo-1',
    language: 'cpp',
    members: [{ path: '.', visibleResults: true }],
    serverSource: { type: 'automatic' },
    enabled: true,
    revision: 1,
    ...overrides
  }
}

describe('buildCodePanelMemberRows', () => {
  it('merges same-path members across languages into one row with both badges', () => {
    const consent = {
      configurationFingerprint: 'fp',
      grantedAt: 1,
      authorizedMembers: [{ path: 'src/core', visibleResults: true }]
    }
    const rows = buildCodePanelMemberRows([
      scope({ language: 'cpp', members: [{ path: 'src/core', visibleResults: true }], consent }),
      scope({
        id: 'local:worktree:repo-1:python',
        language: 'python',
        members: [{ path: 'src/core', visibleResults: true }],
        consent
      })
    ])
    expect(rows).toEqual([
      {
        path: 'src/core',
        directory: '/ws/repo-1/src/core',
        languages: ['cpp', 'python'],
        browseBlocked: false
      }
    ])
  })

  it('sorts merged rows by path', () => {
    const rows = buildCodePanelMemberRows([
      scope({ members: [{ path: 'zzz', visibleResults: true }] }),
      scope({ members: [{ path: '.', visibleResults: true }, { path: 'abc', visibleResults: true }] })
    ])
    expect(rows.map((row) => row.path)).toEqual(['.', 'abc', 'zzz'])
    expect(rows.map((row) => row.directory)).toEqual([
      '/ws/repo-1',
      '/ws/repo-1/abc',
      '/ws/repo-1/zzz'
    ])
  })

  it('keeps host-absolute member paths verbatim', () => {
    const rows = buildCodePanelMemberRows([
      scope({ members: [{ path: '/opt/toolchain/sysroot', visibleResults: true }] })
    ])
    expect(rows[0]?.path).toBe('/opt/toolchain/sysroot')
    expect(rows[0]?.directory).toBe('/opt/toolchain/sysroot')
  })

  it('marks rows browse-blocked when an owning scope has no consent', () => {
    const rows = buildCodePanelMemberRows([
      scope({
        language: 'cpp',
        members: [{ path: 'src', visibleResults: true }],
        consent: undefined
      }),
      scope({
        id: 'local:worktree:repo-1:python',
        language: 'python',
        members: [{ path: 'tools', visibleResults: true }],
        consent: {
          configurationFingerprint: 'fp',
          grantedAt: 1,
          authorizedMembers: [{ path: 'tools', visibleResults: true }]
        }
      })
    ])
    expect(rows).toEqual([
      { path: 'src', directory: '/ws/repo-1/src', languages: ['cpp'], browseBlocked: true },
      {
        path: 'tools',
        directory: '/ws/repo-1/tools',
        languages: ['python'],
        browseBlocked: false
      }
    ])
  })

  it('blocks a merged row when only one of its languages is unauthorized', () => {
    const consent = {
      configurationFingerprint: 'fp',
      grantedAt: 1,
      authorizedMembers: [{ path: 'src', visibleResults: true }]
    }
    const rows = buildCodePanelMemberRows([
      scope({ language: 'cpp', members: [{ path: 'src', visibleResults: true }], consent }),
      scope({
        id: 'local:worktree:repo-1:python',
        language: 'python',
        members: [{ path: 'src', visibleResults: true }],
        consent: undefined
      })
    ])
    expect(rows).toEqual([
      {
        path: 'src',
        directory: '/ws/repo-1/src',
        languages: ['cpp', 'python'],
        browseBlocked: true
      }
    ])
  })

  it('marks rows browse-blocked when consent went stale', () => {
    const rows = buildCodePanelMemberRows([
      scope({
        members: [{ path: 'src', visibleResults: true }],
        consent: {
          configurationFingerprint: 'fp',
          grantedAt: 1,
          authorizedMembers: [{ path: 'older', visibleResults: true }]
        }
      })
    ])
    expect(rows[0]?.browseBlocked).toBe(true)
  })

  it('leaves rows browsable when consent matches the member snapshot', () => {
    const rows = buildCodePanelMemberRows([
      scope({
        members: [{ path: 'src', visibleResults: true }],
        consent: {
          configurationFingerprint: 'fp',
          grantedAt: 1,
          authorizedMembers: [{ path: 'src', visibleResults: true }]
        }
      })
    ])
    expect(rows[0]?.browseBlocked).toBe(false)
  })
})

describe('resolveCodePanelMemberDirectory', () => {
  it('maps the workspace-root member to the root itself', () => {
    expect(resolveCodePanelMemberDirectory('/ws/repo-1', '.')).toBe('/ws/repo-1')
  })

  it('joins relative members onto the workspace root', () => {
    expect(resolveCodePanelMemberDirectory('/ws/repo-1', 'third_party/libwebp')).toBe(
      '/ws/repo-1/third_party/libwebp'
    )
  })

  it('keeps host-absolute members verbatim', () => {
    expect(resolveCodePanelMemberDirectory('/ws/repo-1', '/opt/sysroot')).toBe('/opt/sysroot')
  })
})

describe('getCodePanelKeptEmptyLanguages', () => {
  it('lists languages of scopes that exist but hold no members', () => {
    const languages = getCodePanelKeptEmptyLanguages([
      scope({ language: 'cpp', members: [] }),
      scope({ id: 'local:worktree:repo-1:python', language: 'python', members: [] })
    ])
    expect(languages).toEqual(['cpp', 'python'])
  })

  it('omits languages whose scopes still have members', () => {
    const languages = getCodePanelKeptEmptyLanguages([
      scope({ language: 'cpp', members: [{ path: 'src', visibleResults: true }] }),
      scope({ id: 'local:worktree:repo-1:python', language: 'python', members: [] })
    ])
    expect(languages).toEqual(['python'])
  })
})
