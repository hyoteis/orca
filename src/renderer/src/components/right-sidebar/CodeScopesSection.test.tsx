// @vitest-environment happy-dom

import { useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry, GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import type { CodeIntelligenceScope } from '../../../../shared/code-intelligence-scope'

const mockState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  activeWorktreeId: 'repo-1::/ws/repo-1' as string | null,
  repos: [] as Repo[],
  worktreesByRepo: {} as Record<string, Worktree[]>,
  folderWorkspaces: [] as unknown[],
  // Slices read by the worktree-menu action wiring (operation owner, download gating).
  detectedWorktreesByRepo: {} as Record<string, unknown>,
  projectGroups: [] as unknown[],
  restoredRuntimeHostIdByWorkspaceSessionKey: {} as Record<string, unknown>,
  sshConnectionStates: new Map<string, { supportsFolderDownload?: boolean }>(),
  sshStateByEnvironment: new Map<string, unknown>(),
  openFiles: [] as unknown[],
  closeFile: vi.fn(),
  showRightSidebarSearch: vi.fn(),
  openModal: vi.fn(),
  openFile: vi.fn(),
  fetchSettings: vi.fn()
}))

const windowApi = vi.hoisted(() => ({
  codeIntelligence: { upsertScope: vi.fn() },
  shell: { openPath: vi.fn() }
}))

const createNewTerminalTabMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/terminal/terminal-tab-create', () => ({
  createNewTerminalTab: createNewTerminalTabMock
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
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
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values
      ? Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { CodeScopesSection } from './CodeScopesSection'

// Controlled-state harness: mirrors how FileExplorer drives the accordion.
function CodeScopesHarness(props: Omit<ComponentProps<typeof CodeScopesSection>, 'collapsed' | 'onToggleCollapsed'>) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <CodeScopesSection
      {...props}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
    />
  )
}

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
  repos = [{ id: 'repo-1' } as unknown as Repo],
  activeWorktreeId,
  folderWorkspaces = []
}: {
  scopes?: CodeIntelligenceScope[]
  worktreeHostId?: string
  repos?: Repo[]
  activeWorktreeId?: string
  folderWorkspaces?: unknown[]
} = {}): void {
  mockState.settings = { codeIntelligenceScopes: scopes } as unknown as GlobalSettings
  mockState.repos = repos
  mockState.activeWorktreeId = activeWorktreeId ?? 'repo-1::/ws/repo-1'
  mockState.folderWorkspaces = folderWorkspaces
  mockState.worktreesByRepo = activeWorktreeId?.startsWith('folder:')
    ? {}
    : {
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
  mockState.openFile.mockReset()
  mockState.fetchSettings.mockReset()
  windowApi.codeIntelligence.upsertScope.mockReset().mockResolvedValue({})
  windowApi.shell.openPath.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { api: typeof windowApi }).api = windowApi
})

describe('CodeScopesSection shell', () => {
  it('renders the section titled exactly "Workspace" above its member rows', () => {
    setupState()
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy()
  })

  it('hides the section when the workspace has no scopes (OpenEditorsSection precedent)', () => {
    setupState({ scopes: [] })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    expect(screen.queryByText('Workspace')).toBeNull()
  })

  it('fills the freed panel height when the worktree section is collapsed', () => {
    setupState()
    const { container } = render(<CodeScopesHarness listDirectory={vi.fn()} fillRemaining />)
    expect((container.firstElementChild as HTMLElement).className).toContain('flex-1')
    const scrollArea = container.querySelector('[data-slot="scroll-area"]') as HTMLElement
    expect(scrollArea.className).not.toContain('max-h-64')
    expect(scrollArea.className).toContain('flex-1')
  })

  it('collapses and re-expands the section body from the header', () => {
    setupState()
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle workspace section' }))
    expect(screen.queryByRole('button', { name: /src/ })).toBeNull()
    expect(screen.getByText('Workspace')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle workspace section' }))
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy()
  })

  it('opens the configure dialog from the in-section gear affordance', () => {
    setupState({
      scopes: [scope({ executionHostId: 'ssh:my-host' })],
      worktreeHostId: 'ssh:my-host'
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Configure Code' }))
    expect(mockState.openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1'
    })
  })

  it('disables the gear when no cpp scope backs a configure target', () => {
    setupState({
      scopes: [
        scope({
          id: 'local:worktree:repo-1:python',
          language: 'python',
          members: [{ path: 'src', visibleResults: true }]
        })
      ]
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    const gear = screen.getByRole('button', { name: 'Configure Code' }) as HTMLButtonElement
    expect(gear.disabled).toBe(true)
  })
})

describe('CodeScopesSection member rows', () => {
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
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    const rows = screen.getAllByRole('button', { name: /src\/core/ })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('C++')
    expect(rows[0]?.textContent).toContain('Py')
  })

  it('blocks browsing for members of unconsented scopes', () => {
    const listDirectory = vi.fn()
    setupState({
      scopes: [scope({ members: [{ path: 'src', visibleResults: true }], consent: undefined })]
    })
    render(<CodeScopesHarness listDirectory={listDirectory} />)
    const row = screen.getByRole('button', { name: /src/ })
    fireEvent.click(row)
    expect(listDirectory).not.toHaveBeenCalled()
    expect(row.title).toMatch(/Authorize/i)
  })
})

describe('CodeScopesSection browsing', () => {
  it('expands a member root and lists entries through the injected lister', async () => {
    const listDirectory = vi.fn().mockResolvedValue([dir('include'), file('main.cpp')])
    setupState()
    render(<CodeScopesHarness listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith('/ws/repo-1/src'))
    expect(await screen.findByText('include')).toBeTruthy()
    expect(screen.getByText('main.cpp')).toBeTruthy()
  })

  it('opens a file row through the editor open path', async () => {
    const listDirectory = vi.fn().mockResolvedValue([dir('include'), file('main.cpp')])
    setupState()
    render(<CodeScopesHarness listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    const fileRow = await screen.findByRole('button', { name: 'main.cpp' })
    fireEvent.click(fileRow)
    expect(mockState.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/ws/repo-1/src/main.cpp',
        worktreeId: 'repo-1::/ws/repo-1',
        mode: 'edit'
      }),
      expect.objectContaining({ preview: true, focusEditor: true })
    )
  })

  it('expands a nested directory row on click', async () => {
    const listDirectory = vi
      .fn()
      .mockResolvedValueOnce([dir('include')])
      .mockResolvedValueOnce([file('app.h')])
    setupState()
    render(<CodeScopesHarness listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    fireEvent.click(await screen.findByText('include'))
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith('/ws/repo-1/src/include'))
    expect(await screen.findByText('app.h')).toBeTruthy()
  })

  it('hides the root member row for whole-folder scopes and lists children directly', async () => {
    const listDirectory = vi.fn().mockResolvedValue([dir('src'), file('README.md')])
    setupState({
      scopes: [
        scope({
          members: [{ path: '.', visibleResults: true }],
          consent: {
            configurationFingerprint: 'fp',
            grantedAt: 1,
            authorizedMembers: [{ path: '.', visibleResults: true }]
          }
        })
      ]
    })
    const { container } = render(<CodeScopesHarness listDirectory={listDirectory} />)
    // '.' member: no folder-name row; the root auto-expands inside a scroll area.
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith('/ws/repo-1'))
    expect(await screen.findByRole('button', { name: 'src' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'README.md' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^repo-1$/ })).toBeNull()
    expect(container.querySelector('[data-slot="scroll-area"]')).toBeTruthy()
  })

  it('offers the worktree context menu on child folder rows', async () => {
    const listDirectory = vi.fn().mockResolvedValue([dir('include')])
    setupState()
    render(<CodeScopesHarness listDirectory={listDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    const childRow = await screen.findByRole('button', { name: 'include' })
    fireEvent.contextMenu(childRow)
    // Shortcut chips append to the accessible name, so match by prefix.
    for (const label of [
      'New File',
      'New Folder',
      'Copy Path',
      'Open in Terminal',
      'Find in Folder',
      'Rename',
      'Delete'
    ]) {
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Terminal' }))
    await waitFor(() =>
      expect(createNewTerminalTabMock).toHaveBeenCalledWith('repo-1::/ws/repo-1', undefined, {
        startupCwd: '/ws/repo-1/src/include'
      })
    )
  })
})

describe('CodeScopesSection folder workspace bridging', () => {
  const FOLDER_REPO = {
    id: 'repo-1',
    kind: 'folder',
    path: '/ws/repo-1',
    displayName: 'DiligentEngine',
    connectionId: undefined
  } as unknown as Repo
  const FOLDER_WS = {
    id: 'fw-1',
    projectGroupId: 'pg-1',
    name: 'ws',
    folderPath: '/ws/repo-1',
    connectionId: undefined,
    executionHostId: undefined
  } as unknown as Record<string, unknown>

  it('renders the linked project scopes with a provenance info line', () => {
    setupState({
      activeWorktreeId: 'folder:fw-1',
      folderWorkspaces: [FOLDER_WS],
      repos: [FOLDER_REPO],
      scopes: [
        scope({
          id: 'local:folder:repo-1:cpp',
          workspaceKey: 'folder:repo-1'
        })
      ]
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy()
    expect(screen.getByText(/DiligentEngine/)).toBeTruthy()
    expect(screen.getByText(/linked project/)).toBeTruthy()
  })

  it('shows the add-as-project empty state when no folder repo is linked', () => {
    setupState({
      activeWorktreeId: 'folder:fw-1',
      folderWorkspaces: [FOLDER_WS],
      repos: [],
      scopes: []
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    expect(screen.getByText('Workspace')).toBeTruthy()
    expect(screen.getByText('This folder is not a project yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add Folder as Project/ }))
    expect(mockState.openModal).toHaveBeenCalledWith('confirm-add-project-from-folder', {
      folderPath: '/ws/repo-1',
      runtimeEnvironmentId: null
    })
  })

  it('opens the configure dialog from the bridged repo', () => {
    setupState({
      activeWorktreeId: 'folder:fw-1',
      folderWorkspaces: [FOLDER_WS],
      repos: [FOLDER_REPO],
      scopes: [
        scope({
          id: 'local:folder:repo-1:cpp',
          workspaceKey: 'folder:repo-1'
        })
      ]
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    const gear = screen.getByRole('button', { name: 'Configure Code' }) as HTMLButtonElement
    expect(gear.disabled).toBe(false)
    fireEvent.click(gear)
    expect(mockState.openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1'
    })
  })

  it('refuses reveal for a bridged ssh workspace', async () => {
    const { toast } = await import('sonner')
    setupState({
      activeWorktreeId: 'folder:fw-1',
      folderWorkspaces: [{ ...FOLDER_WS, connectionId: 'my-host' }],
      repos: [
        {
          id: 'repo-1',
          kind: 'folder',
          path: '/ws/repo-1',
          displayName: 'DiligentEngine',
          connectionId: 'my-host'
        } as unknown as Repo
      ],
      scopes: [
        scope({
          id: 'ssh:folder:repo-1:cpp',
          workspaceKey: 'folder:repo-1',
          executionHostId: 'ssh:my-host'
        })
      ]
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /src/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Manager' }))
    expect(windowApi.shell.openPath).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})

describe('CodeScopesSection member context menu', () => {
  const openMemberMenu = (): void => {
    fireEvent.contextMenu(screen.getByRole('button', { name: /src/ }))
  }

  it('offers all four actions on a member row', () => {
    setupState()
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
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
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    openMemberMenu()
    expect(screen.queryByRole('menuitem', { name: 'Configure Code…' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy()
  })

  it('removes the member through the single writer and keeps the emptied scope', async () => {
    setupState({ scopes: [scope({ members: [{ path: 'src', visibleResults: true }] })] })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
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
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
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
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure Code…' }))
    expect(mockState.openModal).toHaveBeenCalledWith('code-intelligence-cpp-setup', {
      repoId: 'repo-1'
    })
  })

  it('opens the member directory through the add-project flow', () => {
    setupState()
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open as Workspace' }))
    expect(mockState.openModal).toHaveBeenCalledWith('confirm-add-project-from-folder', {
      folderPath: '/ws/repo-1/src',
      runtimeEnvironmentId: null
    })
  })

  it('reveals local member directories in the OS file manager', () => {
    setupState()
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Manager' }))
    expect(windowApi.shell.openPath).toHaveBeenCalledWith('/ws/repo-1/src')
  })

  it('refuses to reveal members of SSH workspaces, matching FileExplorer', async () => {
    const { toast } = await import('sonner')
    setupState({
      worktreeHostId: 'ssh:my-host',
      scopes: [
        scope({ executionHostId: 'ssh:my-host', members: [{ path: 'src', visibleResults: true }] })
      ],
      repos: [{ id: 'repo-1', connectionId: 'my-host' } as unknown as Repo]
    })
    render(<CodeScopesHarness listDirectory={vi.fn()} />)
    openMemberMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Manager' }))
    expect(windowApi.shell.openPath).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
