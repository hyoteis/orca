// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry, GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

const mockState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  activeWorktreeId: 'repo-1::/ws/repo-1' as string | null,
  repos: [] as Repo[],
  worktreesByRepo: {} as Record<string, Worktree[]>,
  folderWorkspaces: []
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof mockState) => T): T => selector(mockState)
}))

vi.mock('@/store/selectors', () => ({
  useWorktreeMap: () => {
    const map = new Map<string, Worktree>()
    for (const worktrees of Object.values(mockState.worktreesByRepo)) {
      for (const worktree of worktrees) {
        map.set(worktree.id, worktree)
      }
    }
    return map
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { CodePanel } from './CodePanel'

afterEach(cleanup)

const CONSENT = {
  configurationFingerprint: 'fp',
  grantedAt: 1,
  authorizedMembers: [{ path: 'src', visibleResults: true }]
}

function scope(overrides: Partial<CodeIntelligenceScope>): CodeIntelligenceScope {
  return {
    id: 'local:worktree:repo-1:cpp',
    name: 'repo-1',
    executionHostId: 'local',
    workspaceKey: 'worktree:repo-1',
    workspaceRoot: '/ws/repo-1',
    language: 'cpp',
    members: [{ path: 'src', visibleResults: true }],
    serverSource: { type: 'automatic' },
    consent: CONSENT,
    enabled: true,
    revision: 1,
    ...overrides
  }
}

const dir = (name: string): DirEntry => ({ name, isDirectory: true, isSymlink: false })
const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })

function setupState({
  scopes = [scope({})],
  worktreeHostId = 'local'
}: {
  scopes?: CodeIntelligenceScope[]
  worktreeHostId?: string
} = {}): void {
  mockState.settings = { codeIntelligenceScopes: scopes } as unknown as GlobalSettings
  mockState.repos = []
  mockState.worktreesByRepo = {
    'repo-1': [
      {
        id: 'repo-1::/ws/repo-1',
        repoId: 'repo-1',
        hostId: worktreeHostId,
        path: '/ws/repo-1'
      } as unknown as Worktree
    ]
  }
}

beforeEach(() => {
  mockState.folderWorkspaces = []
})

describe('CodePanel member rows', () => {
  it('renders merged member rows with one badge per language', () => {
    setupState({
      scopes: [
        scope({ language: 'cpp', members: [{ path: 'src/core', visibleResults: true }] }),
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [{ path: 'src/core', visibleResults: true }],
          consent: {
            configurationFingerprint: 'fp',
            grantedAt: 1,
            authorizedMembers: [{ path: 'src/core', visibleResults: true }]
          }
        })
      ]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    const rows = screen.getAllByRole('button', { name: /src\/core/ })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('C++')
    expect(rows[0]?.textContent).toContain('Py')
  })

  it('shows the ghost empty state when the workspace has no scopes', () => {
    setupState({ scopes: [] })
    render(<CodePanel listDirectory={vi.fn()} />)
    expect(screen.getByText('No code scopes for this workspace on this host.')).toBeTruthy()
  })

  it('shows kept-empty hints per language for empty scopes', () => {
    setupState({
      scopes: [
        scope({ language: 'cpp', members: [], consent: CONSENT }),
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [],
          consent: {
            configurationFingerprint: 'fp',
            grantedAt: 1,
            authorizedMembers: []
          }
        })
      ]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    expect(screen.getByText(/C\+\+ scope is empty — kept/)).toBeTruthy()
    expect(screen.getByText(/Python scope is empty — kept/)).toBeTruthy()
  })

  it('shows a kept-empty hint alongside rows of a non-empty sibling scope', () => {
    setupState({
      scopes: [
        scope({ language: 'cpp', members: [{ path: 'src', visibleResults: true }] }),
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [],
          consent: {
            configurationFingerprint: 'fp',
            grantedAt: 1,
            authorizedMembers: []
          }
        })
      ]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy()
    expect(screen.getByText(/Python scope is empty — kept/)).toBeTruthy()
  })

  it('blocks browsing for members of unconsented scopes', () => {
    const listDirectory = vi.fn()
    setupState({
      scopes: [scope({ members: [{ path: 'src', visibleResults: true }], consent: undefined })]
    })
    render(<CodePanel listDirectory={listDirectory} />)
    const row = screen.getByRole('button', { name: /src/ })
    fireEvent.click(row)
    expect(listDirectory).not.toHaveBeenCalled()
    expect(row.title).toMatch(/Authorize/i)
  })
})

describe('CodePanel browsing', () => {
  it('expands a member root and lists entries through the injected lister', async () => {
    const listDirectory = vi.fn().mockResolvedValue([dir('include'), file('main.cpp')])
    setupState()
    render(<CodePanel listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith('/ws/repo-1/src'))
    expect(await screen.findByText('include')).toBeTruthy()
    expect(screen.getByText('main.cpp')).toBeTruthy()
  })

  it('expands a nested directory row on click', async () => {
    const listDirectory = vi
      .fn()
      .mockResolvedValueOnce([dir('include')])
      .mockResolvedValueOnce([file('app.h')])
    setupState()
    render(<CodePanel listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    fireEvent.click(await screen.findByText('include'))
    await waitFor(() =>
      expect(listDirectory).toHaveBeenLastCalledWith('/ws/repo-1/src/include')
    )
    expect(await screen.findByText('app.h')).toBeTruthy()
  })
})

describe('CodePanel header', () => {
  it('shows the active host label and a disabled Add Folder placeholder', () => {
    setupState({
      scopes: [scope({ executionHostId: 'ssh:my-host' })],
      worktreeHostId: 'ssh:my-host'
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    const addFolder = screen.getByRole('button', { name: /Add Folder/ })
    expect((addFolder as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/my-host/)).toBeTruthy()
  })
})
