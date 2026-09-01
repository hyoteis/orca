import { describe, expect, it } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  countCodeIntelligenceScopeFolders,
  getCodeIntelligenceMemberDisplayPath,
  getStatusBarCodeIntelligenceScopes
} from './code-intelligence-status-scopes'

const scopes: CodeIntelligenceScope[] = [
  {
    id: 'cpp-local',
    name: 'Engine C++',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: 'C:\\repo',
    language: 'cpp',
    members: [
      { path: 'Core', visibleResults: true },
      { path: 'FX', visibleResults: true },
      { path: 'D:\\sdk\\external', visibleResults: false }
    ],
    serverSource: { type: 'automatic' },
    enabled: true,
    revision: 1
  },
  {
    id: 'cpp-remote',
    name: 'Remote C++',
    executionHostId: 'ssh:host',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/repo',
    language: 'cpp',
    members: [{ path: '.', visibleResults: true }],
    serverSource: { type: 'automatic' },
    enabled: true,
    revision: 1
  }
]

describe('code intelligence status scopes', () => {
  it('shows enabled scopes for the active repo and execution host', () => {
    const result = getStatusBarCodeIntelligenceScopes({
      settings: { codeIntelligenceScopes: scopes } as never,
      activeWorktreeId: 'repo-1::C:\\repo',
      executionHostId: 'local'
    })

    expect(result.map((scope) => scope.id)).toEqual(['cpp-local'])
    expect(countCodeIntelligenceScopeFolders(result)).toBe(3)
  })

  it('formats relative members below the workspace root and absolute members as-is', () => {
    expect(getCodeIntelligenceMemberDisplayPath(scopes[0], scopes[0].members[0])).toBe(
      'C:\\repo/Core'
    )
    expect(getCodeIntelligenceMemberDisplayPath(scopes[1], scopes[1].members[0])).toBe('/repo')
    expect(getCodeIntelligenceMemberDisplayPath(scopes[0], scopes[0].members[2])).toBe(
      'D:\\sdk\\external'
    )
  })
})
