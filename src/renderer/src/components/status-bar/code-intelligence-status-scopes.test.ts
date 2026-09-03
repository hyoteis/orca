import { describe, expect, it } from 'vitest'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'
import {
  countCodeIntelligenceScopeFolders,
  findSessionLinkedFolderRepo,
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

const FOLDER_WS = {
  id: 'fw-1',
  projectGroupId: 'pg-1',
  name: 'workspace',
  folderPath: 'D:/ws/folder',
  connectionId: undefined,
  executionHostId: undefined
} as never

const FOLDER_REPO = {
  id: 'repo-9',
  kind: 'folder',
  path: 'D:/ws/folder',
  displayName: 'folder',
  connectionId: undefined,
  executionHostId: undefined
} as never

describe('code intelligence status scopes', () => {
  it('bridges folder workspace sessions to the linked folder repo scopes', () => {
    const result = getStatusBarCodeIntelligenceScopes({
      settings: {
        codeIntelligenceScopes: [
          {
            ...scopes[0]!,
            id: 'folder-cpp',
            workspaceKey: 'folder:repo-9'
          }
        ]
      } as never,
      activeWorktreeId: 'folder:fw-1',
      executionHostId: 'local',
      folderWorkspaces: [FOLDER_WS],
      repos: [FOLDER_REPO]
    })

    expect(result.map((scope) => scope.id)).toEqual(['folder-cpp'])
  })

  it('returns no scopes for folder sessions without a linked repo', () => {
    const result = getStatusBarCodeIntelligenceScopes({
      settings: { codeIntelligenceScopes: scopes } as never,
      activeWorktreeId: 'folder:fw-1',
      executionHostId: 'local',
      folderWorkspaces: [FOLDER_WS],
      repos: []
    })

    expect(result).toEqual([])
  })

  it('returns no scopes for folder sessions when bridging inputs are absent', () => {
    const result = getStatusBarCodeIntelligenceScopes({
      settings: { codeIntelligenceScopes: scopes } as never,
      activeWorktreeId: 'folder:fw-1',
      executionHostId: 'local'
    })

    expect(result).toEqual([])
  })

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

describe('findSessionLinkedFolderRepo', () => {
  it('resolves the same-path folder repo for folder sessions', () => {
    expect(
      findSessionLinkedFolderRepo({
        activeWorktreeId: 'folder:fw-1',
        folderWorkspaces: [FOLDER_WS],
        repos: [FOLDER_REPO]
      })?.id
    ).toBe('repo-9')
  })

  it('returns null for worktree sessions and unbridgeable folder sessions', () => {
    expect(
      findSessionLinkedFolderRepo({
        activeWorktreeId: 'repo-1::C:\\repo',
        folderWorkspaces: [FOLDER_WS],
        repos: [FOLDER_REPO]
      })
    ).toBe(null)
    expect(
      findSessionLinkedFolderRepo({
        activeWorktreeId: 'folder:fw-1',
        folderWorkspaces: [],
        repos: [FOLDER_REPO]
      })
    ).toBe(null)
    expect(
      findSessionLinkedFolderRepo({
        activeWorktreeId: 'folder:fw-1',
        folderWorkspaces: [FOLDER_WS],
        repos: []
      })
    ).toBe(null)
  })
})
