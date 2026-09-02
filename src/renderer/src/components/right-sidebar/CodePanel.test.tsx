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
  folderWorkspaces: [],
  openModal: vi.fn(),
  fetchSettings: vi.fn()
}))

const windowApi = vi.hoisted(() => ({
  codeIntelligence: { upsertScope: vi.fn() },
  shell: { openPath: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof mockState) => T): T => selector(mockState),
    { getState: () => mockState }
  )
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
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
  worktreeHostId = 'local',
  repos = [{ id: 'repo-1' } as unknown as Repo]
}: {
  scopes?: CodeIntelligenceScope[]
  worktreeHostId?: string
  repos?: Repo[]
} = {}): void {
  mockState.settings = { codeIntelligenceScopes: scopes } as unknown as GlobalSettings
  mockState.repos = repos
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
  mockState.openModal.mockReset()
  mockState.fetchSettings.mockReset()
  windowApi.codeIntelligence.upsertScope.mockReset().mockResolvedValue({})
  windowApi.shell.openPath.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { api: typeof windowApi }).api = windowApi
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
  it('shows the active host label and opens the add-folder picker from the header', () => {
    setupState({
      scopes: [scope({ executionHostId: 'ssh:my-host' })],
      worktreeHostId: 'ssh:my-host'
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    const addFolder = screen.getByRole('button', { name: /Add Folder/ })
    expect((addFolder as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(addFolder)
    expect(screen.getByText('Add Folder to Code Scopes')).toBeTruthy()
    expect(screen.getByText(/my-host/)).toBeTruthy()
  })
})

describe('CodePanel member context menu', () => {
  const openMemberMenu = (): void => {
    fireEvent.contextMenu(screen.getByRole('button', { name: /src/ }))
  }

  it('offers all four actions on a member row', () => {
    setupState()
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    expect(screen.getByRole('menuitem', { name: 'Open as Workspace' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Reveal in File Manager' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Configure Code…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy()
  })

  it('hides Configure Code… on python-only rows', () => {
    setupState({
      scopes: [
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [{ path: 'src', visibleResults: true }]
        })
      ]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    expect(screen.queryByRole('menuitem', { name: 'Configure Code…' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy()
  })

  it('removes the member through the single writer and keeps the emptied scope', async () => {
    setupState({ scopes: [scope({ members: [{ path: 'src', visibleResults: true }] })] })
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(1))
    expect(windowApi.codeIntelligence.upsertScope.mock.calls[0]?.[0]).toMatchObject({
      id: 'local:worktree:repo-1:cpp',
      members: []
    })
    expect(mockState.fetchSettings).toHaveBeenCalled()
  })

  it('removes a merged row from every owning scope', async () => {
    setupState({
      scopes: [
        scope({ members: [{ path: 'src', visibleResults: true }] }),
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [
            { path: 'src', visibleResults: true },
            { path: 'tools', visibleResults: true }
          ]
        })
      ]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    await waitFor(() => expect(windowApi.codeIntelligence.upsertScope).toHaveBeenCalledTimes(2))
    const edited = windowApi.codeIntelligence.upsertScope.mock.calls.map(
      (call) => call[0] as { id: string; members: { path: string }[] }
    )
    expect(edited.map((s) => ({ id: s.id, members: s.members.map((m) => m.path) }))).toEqual([
      { id: 'local:worktree:repo-1:cpp', members: [] },
      { id: 'local:worktree:repo-1:python', members: ['tools'] }
    ])
  })

  it('opens the C++ setup dialog scoped to the workspace repo', () => {
    setupState()
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure Code…' }))
    expect(mockState.openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1'
    })
  })

  it('opens the member directory through the add-project flow', () => {
    setupState()
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open as Workspace' }))
    expect(mockState.openModal).toHaveBeenCalledWith('confirm-add-project-from-folder', {
      folderPath: '/ws/repo-1/src',
      runtimeEnvironmentId: null
    })
  })

  it('reveals local member directories in the OS file manager', () => {
    setupState()
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Manager' }))
    expect(windowApi.shell.openPath).toHaveBeenCalledWith('/ws/repo-1/src')
  })

  it('refuses to reveal members of SSH workspaces, matching FileExplorer', async () => {
    const { toast } = await import('sonner')
    setupState({
      worktreeHostId: 'ssh:my-host',
      scopes: [scope({ executionHostId: 'ssh:my-host', members: [{ path: 'src', visibleResults: true }] })],
      repos: [{ id: 'repo-1', connectionId: 'my-host' } as unknown as Repo]
    })
    render(<CodePanel listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Manager' }))
    expect(windowApi.shell.openPath).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
