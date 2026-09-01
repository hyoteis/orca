import { describe, expect, it } from 'vitest'
import { createRepositoryCodeIntelligenceScope } from './repository-code-intelligence-scope'

describe('repository code intelligence scopes', () => {
  it('creates a Host/workspace-bound scope without modifying repository files', () => {
    expect(
      createRepositoryCodeIntelligenceScope({
        repoId: 'repo',
        repoName: 'Engine',
        repoPath: '/workspace/engine',
        isFolder: true,
        executionHostId: 'ssh:box',
        language: 'cpp'
      })
    ).toMatchObject({
      id: 'ssh%3Abox:folder:repo:cpp',
      workspaceKey: 'folder:repo',
      workspaceRoot: '/workspace/engine',
      executionHostId: 'ssh:box',
      members: [{ path: '.', visibleResults: true }]
    })
  })
})
