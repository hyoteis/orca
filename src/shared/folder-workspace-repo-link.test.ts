import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, Repo } from './types'
import {
  findFolderWorkspaceLinkedRepo,
  getFolderWorkspaceExecutionHostId
} from './folder-workspace-repo-link'

const workspace = (overrides: Partial<FolderWorkspace>): FolderWorkspace =>
  ({
    id: 'fw-1',
    projectGroupId: 'pg-1',
    name: 'workspace',
    folderPath: '/ws/repo-1',
    connectionId: undefined,
    executionHostId: undefined,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }) as FolderWorkspace

const repo = (overrides: Partial<Repo>): Repo =>
  ({
    id: 'repo-1',
    kind: 'folder',
    path: '/ws/repo-1',
    displayName: 'repo-1',
    connectionId: undefined,
    executionHostId: undefined,
    ...overrides
  }) as unknown as Repo

describe('getFolderWorkspaceExecutionHostId', () => {
  it('defaults to local', () => {
    expect(getFolderWorkspaceExecutionHostId(workspace({}))).toBe('local')
  })

  it('maps a connectionId to the ssh host', () => {
    expect(getFolderWorkspaceExecutionHostId(workspace({ connectionId: 'my-host' }))).toBe(
      'ssh:my-host'
    )
  })

  it('prefers the explicit executionHostId stamp', () => {
    expect(
      getFolderWorkspaceExecutionHostId(
        workspace({ executionHostId: 'local', connectionId: 'my-host' })
      )
    ).toBe('local')
  })
})

describe('findFolderWorkspaceLinkedRepo', () => {
  it('matches the folder repo by normalized path on the same host', () => {
    const linked = findFolderWorkspaceLinkedRepo(workspace({ folderPath: '/ws/repo-1/' }), [
      repo({ path: '/ws/repo-1' })
    ])
    expect(linked?.id).toBe('repo-1')
  })

  it('ignores git-kind repos at the same path', () => {
    expect(
      findFolderWorkspaceLinkedRepo(workspace({}), [repo({ kind: 'git' })])
    ).toBeNull()
  })

  it('ignores same-path repos on a different host', () => {
    expect(
      findFolderWorkspaceLinkedRepo(workspace({ connectionId: 'my-host' }), [repo({})])
    ).toBeNull()
  })

  it('matches an ssh workspace to the repo on the same connection', () => {
    const linked = findFolderWorkspaceLinkedRepo(workspace({ connectionId: 'my-host' }), [
      repo({ connectionId: 'my-host' })
    ])
    expect(linked?.id).toBe('repo-1')
  })

  it('returns null when no repo path matches', () => {
    expect(findFolderWorkspaceLinkedRepo(workspace({}), [repo({ path: '/other' })])).toBeNull()
  })
})
