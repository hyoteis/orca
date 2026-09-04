import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceEditOperationHostId,
  workspaceEditStagingPath
} from './workspace-edit-editor-ports'

describe('resolveWorkspaceEditOperationHostId', () => {
  it('prefers the active runtime environment', () => {
    expect(
      resolveWorkspaceEditOperationHostId({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'w',
        worktreePath: '/repo',
        expectedExecutionHostId: 'local'
      })
    ).toBe('runtime:env-1')
  })

  it('uses the expected execution host, then the SSH connection', () => {
    expect(
      resolveWorkspaceEditOperationHostId({
        settings: null,
        worktreeId: 'w',
        worktreePath: '/repo',
        expectedExecutionHostId: 'ssh:host-1'
      })
    ).toBe('ssh:host-1')
    expect(
      resolveWorkspaceEditOperationHostId({
        settings: null,
        worktreeId: 'w',
        worktreePath: '/repo',
        connectionId: 'target/1'
      })
    ).toBe('ssh:target%2F1')
    expect(
      resolveWorkspaceEditOperationHostId({
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'w',
        worktreePath: '/repo'
      })
    ).toBe('local')
  })
})

describe('workspaceEditStagingPath', () => {
  it('stages beside the target on both POSIX and Windows host paths', () => {
    expect(workspaceEditStagingPath('/repo/src/a.py', 1)).toBe('/repo/src/a.py.orca-we1.tmp')
    expect(workspaceEditStagingPath('C:\\repo\\src\\a.py', 2)).toBe(
      'C:\\repo\\src\\a.py.orca-we2.tmp'
    )
  })
})
