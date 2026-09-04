import { describe, expect, it } from 'vitest'
import {
  authorizeWorkspaceEditTargets,
  memberEditBoundaryPath
} from './workspace-edit-path-authorization'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

const scope: CodeIntelligenceScope = {
  id: 'local:w:python',
  name: 'Scope',
  executionHostId: 'local',
  workspaceKey: 'worktree:w',
  workspaceRoot: '/repo',
  language: 'python',
  members: [
    { path: '/repo/src', visibleResults: true },
    { path: '/repo/tools', visibleResults: true }
  ],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1
}

describe('authorizeWorkspaceEditTargets', () => {
  it('allows targets inside consented members on the scope host', () => {
    const result = authorizeWorkspaceEditTargets({
      scope,
      operationHostId: 'local',
      targets: [
        { uri: 'file:///repo/src/a.py', hostPath: '/repo/src/a.py' },
        { uri: 'file:///repo/tools/run.py', hostPath: '/repo/tools/run.py' }
      ]
    })
    expect(result.blocks).toEqual([])
  })

  it('blocks paths outside every member', () => {
    const result = authorizeWorkspaceEditTargets({
      scope,
      operationHostId: 'local',
      targets: [{ uri: 'file:///repo/vendor/a.py', hostPath: '/repo/vendor/a.py' }]
    })
    expect(result.blocks).toEqual([
      { uri: 'file:///repo/vendor/a.py', hostPath: '/repo/vendor/a.py', reason: 'out-of-scope' }
    ])
  })

  it('blocks targets executed on a different host', () => {
    const result = authorizeWorkspaceEditTargets({
      scope,
      operationHostId: 'ssh:other-host',
      targets: [{ uri: 'file:///repo/src/a.py', hostPath: '/repo/src/a.py' }]
    })
    expect(result.blocks[0]?.reason).toBe('host-mismatch')
  })

  it('blocks non-file URIs', () => {
    const result = authorizeWorkspaceEditTargets({
      scope,
      operationHostId: 'local',
      targets: [{ uri: 'untitled:Untitled-1', hostPath: 'Untitled-1' }]
    })
    expect(result.blocks[0]?.reason).toBe('non-file-uri')
  })

  it('blocks dot-dot traversal that lexically starts inside a member', () => {
    const result = authorizeWorkspaceEditTargets({
      scope,
      operationHostId: 'local',
      targets: [
        {
          uri: 'file:///repo/src/../../etc/passwd',
          hostPath: '/repo/src/../../etc/passwd'
        }
      ]
    })
    expect(result.blocks[0]?.reason).toBe('out-of-scope')
  })

  it('resolves relative members against the workspace root', () => {
    const result = authorizeWorkspaceEditTargets({
      scope: { ...scope, members: [{ path: 'src', visibleResults: true }] },
      operationHostId: 'local',
      targets: [
        { uri: 'file:///repo/src/a.py', hostPath: '/repo/src/a.py' },
        { uri: 'file:///repo/vendor/a.py', hostPath: '/repo/vendor/a.py' }
      ]
    })
    expect(result.blocks.map((block) => block.hostPath)).toEqual(['/repo/vendor/a.py'])
  })
})

describe('memberEditBoundaryPath', () => {
  it('folds Windows member paths for comparison', () => {
    expect(
      memberEditBoundaryPath(
        { workspaceRoot: 'C:\\repo', members: [] },
        { path: 'C:\\repo\\src', visibleResults: true }
      )
    ).toBe('C:/repo/src')
  })
})
