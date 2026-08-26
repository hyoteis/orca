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
      { relativePath: 'Core', visibleResults: true },
      { relativePath: 'FX', visibleResults: true }
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
    members: [{ relativePath: '.', visibleResults: true }],
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
    expect(countCodeIntelligenceScopeFolders(result)).toBe(2)
  })

  it('formats relative members below the workspace root', () => {
    expect(getCodeIntelligenceMemberDisplayPath(scopes[0], 'Core')).toBe('C:\\repo/Core')
    expect(getCodeIntelligenceMemberDisplayPath(scopes[1], '.')).toBe('/repo')
  })
})
