// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import CodeIntelligenceConfigureDialog from './CodeIntelligenceConfigureDialog'

const mocks = vi.hoisted(() => ({
  configureAggregate: vi.fn(),
  revalidateAggregate: vi.fn(),
  pickCompileDatabase: vi.fn(),
  pickDirectory: vi.fn(),
  browseDir: vi.fn(),
  fetchSettings: vi.fn(async () => {}),
  restartSession: vi.fn(() => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() }
}))

vi.mock('@/lib/language-server/cpp-code-intelligence-session', () => ({
  getCppSession: () => ({ restartSession: mocks.restartSession })
}))

const scopeFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'local:worktree:repo-1:cpp',
  name: 'repo-1 C++',
  executionHostId: 'local',
  workspaceKey: 'worktree:repo-1',
  workspaceRoot: 'D:/ws/repo-1',
  language: 'cpp',
  members: [{ path: '.', visibleResults: true }],
  serverSource: { type: 'automatic' },
  enabled: true,
  revision: 1,
  ...overrides
})

beforeEach(() => {
  mocks.configureAggregate.mockReset()
  mocks.revalidateAggregate.mockReset()
  mocks.pickCompileDatabase.mockReset()
  mocks.pickDirectory.mockReset()
  mocks.toastSuccess.mockClear()
  mocks.toastError.mockClear()
  globalThis.window.api = {
    codeIntelligence: {
      configureAggregate: mocks.configureAggregate,
      revalidateAggregate: mocks.revalidateAggregate
    },
    shell: { pickCompileDatabase: mocks.pickCompileDatabase, pickDirectory: mocks.pickDirectory },
    ssh: { browseDir: mocks.browseDir }
  } as unknown as typeof window.api
  useAppStore.setState({
    activeModal: 'code-intelligence-cpp-setup',
    modalData: { repoId: 'repo-1' },
    repos: [
      { id: 'repo-1', path: 'D:/ws/repo-1', displayName: 'repo-1', connectionId: null, executionHostId: 'local', kind: 'git' }
    ],
    settings: { codeIntelligenceScopes: [scopeFixture()] },
    fetchSettings: mocks.fetchSettings,
    sshTargetLabels: new Map()
  } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <CodeIntelligenceConfigureDialog />
    </TooltipProvider>
  )
}

describe('CodeIntelligenceConfigureDialog (#138)', () => {
  it('saves BASIC inline options through configureAggregate', async () => {
    mocks.configureAggregate.mockResolvedValue({
      scope: scopeFixture({ basicOptions: { includeDirectories: ['-I /opt/sdk'], defines: ['USE_GPU=1'] } }),
      mappings: [],
      entryCount: 3
    })
    renderDialog()
    // Default mode for a legacy BASIC scope: BASIC options visible.
    fireEvent.change(screen.getByLabelText(/Include directories/i), {
      target: { value: '-I /opt/sdk' }
    })
    fireEvent.change(screen.getByLabelText(/Defines/i), { target: { value: 'USE_GPU=1' } })
    fireEvent.change(screen.getByLabelText(/C\+\+ standard/i), { target: { value: 'c++20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and authorize' }))
    await waitFor(() => expect(mocks.configureAggregate).toHaveBeenCalledTimes(1))
    expect(mocks.configureAggregate).toHaveBeenCalledWith({
      repoId: 'repo-1',
      mode: 'basic',
      folders: ['.'],
      basicOptions: { includeDirectories: ['-I /opt/sdk'], defines: ['USE_GPU=1'], cppStandard: 'c++20' }
    })
    await waitFor(() => expect(mocks.fetchSettings).toHaveBeenCalled())
  })

  it('warns on partial coverage without blocking save', async () => {
    mocks.revalidateAggregate.mockResolvedValue({
      mappings: [
        { id: 'm1', memberPath: '.', compileDatabase: '/cdb.json', state: 'warning', failure: 'no-in-folder-commands' }
      ],
      entryCount: 88
    })
    renderDialog()
    // Switch to cdb mode so the revalidate control appears.
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    fireEvent.change(screen.getByLabelText('Database path'), { target: { value: '/cdb.json' } })
    fireEvent.click(screen.getByRole('button', { name: /Re-validate and reload/ }))
    await waitFor(() => expect(mocks.revalidateAggregate).toHaveBeenCalledTimes(1))
    const status = await screen.findByRole('status')
    expect(status.getAttribute('data-configure-status')).toBe('warning')
    expect(status.textContent).toContain('88 commands merged')
    expect(status.textContent).toContain('clangd infers the rest')
    // The chip labels partial coverage.
    expect(screen.getByText('Partial coverage')).toBeInTheDocument()
    // Save is still enabled — coverage never blocks.
    expect(screen.getByRole('button', { name: 'Save and authorize' })).not.toBeDisabled()
  })

  it('flags the mode switch as a structure change demanding reauthorization', async () => {
    mocks.configureAggregate.mockResolvedValue({
      scope: scopeFixture({ members: [{ path: '.', visibleResults: true, compileDatabase: '/cdb.json' }] }),
      mappings: [],
      entryCount: 0
    })
    renderDialog()
    expect(screen.queryByText(/Structure changed/i)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    expect(screen.getByText(/Structure changed — saving will request reauthorization/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Database path'), { target: { value: 'D:/build/compile_commands.json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and authorize' }))
    await waitFor(() => expect(mocks.configureAggregate).toHaveBeenCalledWith({
      repoId: 'repo-1',
      mode: 'cdb',
      folders: ['.'],
      compileDatabase: 'D:/build/compile_commands.json'
    }))
  })

  it('keeps Save disabled without a database path in cdb mode', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    expect(screen.getByRole('button', { name: 'Save and authorize' })).toBeDisabled()
  })

  it('restarts the running C++ session on demand (#149)', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    fireEvent.change(screen.getByLabelText('Database path'), { target: { value: '/cdb.json' } })
    fireEvent.click(screen.getByRole('button', { name: /Restart C\+\+ session/ }))
    expect(mocks.restartSession).toHaveBeenCalledWith('local:worktree:repo-1:cpp', 1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('C++ session restarted')
  })

  it('picks a local database through the native browse dialog', async () => {
    mocks.pickCompileDatabase.mockResolvedValue('D:/build/vulkan/compile_commands.json')
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() =>
      expect((screen.getByLabelText('Database path') as HTMLInputElement).value).toBe(
        'D:/build/vulkan/compile_commands.json'
      )
    )
  })

  it('browses the remote host for SSH workspaces and fills the picked path', async () => {
    mocks.browseDir.mockResolvedValue({
      resolvedPath: '/home/dev/build',
      pathFlavor: 'posix',
      entries: [{ name: 'compile_commands.json', isDirectory: false }]
    })
    useAppStore.setState({
      modalData: { repoId: 'repo-2' },
      repos: [
        { id: 'repo-2', path: '/home/dev/ws', displayName: 'ws', connectionId: 'tgt-9', executionHostId: null, kind: 'git' }
      ],
      settings: { codeIntelligenceScopes: [] },
      sshTargetLabels: new Map([['tgt-9', 'buildbox']])
    } as never)
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Compile database' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(screen.getByText('compile_commands.json')).toBeInTheDocument())
    expect(mocks.browseDir).toHaveBeenCalledWith({ targetId: 'tgt-9', dirPath: '~' })
    fireEvent.click(screen.getByText('compile_commands.json'))
    await waitFor(() =>
      expect((screen.getByLabelText('Database path') as HTMLInputElement).value).toBe(
        '/home/dev/build/compile_commands.json'
      )
    )
    expect(mocks.pickCompileDatabase).not.toHaveBeenCalled()
  })

  it('seeds folder rows from the persisted scope members', () => {
    useAppStore.setState({
      settings: {
        codeIntelligenceScopes: [
          scopeFixture({ members: [{ path: 'src', visibleResults: true }, { path: 'tests', visibleResults: true }] })
        ]
      }
    } as never)
    renderDialog()
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('tests')).toBeInTheDocument()
  })

  it('adds a local folder through the native picker and saves the folder set', async () => {
    mocks.pickDirectory.mockResolvedValue('D:/ws/repo-1/graphics')
    mocks.configureAggregate.mockResolvedValue({
      scope: scopeFixture(),
      mappings: [],
      entryCount: 0
    })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    await waitFor(() => expect(screen.getByText('graphics')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Save and authorize' }))
    await waitFor(() =>
      expect(mocks.configureAggregate).toHaveBeenCalledWith({
        repoId: 'repo-1',
        mode: 'basic',
        folders: ['.', 'graphics'],
        basicOptions: { includeDirectories: [], defines: [] }
      })
    )
  })

  it('rejects folders outside the workspace root', async () => {
    mocks.pickDirectory.mockResolvedValue('D:/elsewhere/other')
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(screen.queryByText('other')).toBeNull()
    expect(
      screen.getAllByRole('listitem').filter((item) => item.textContent?.includes('(whole workspace)'))
    ).toHaveLength(1)
  })

  it('flags folder changes as a structure change and blocks save on an empty set', async () => {
    renderDialog()
    expect(screen.queryByText(/Structure changed/i)).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove folder' })[0])
    expect(screen.getByText(/Structure changed — saving will request reauthorization/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and authorize' })).toBeDisabled()
  })

  it('picks an SSH folder through the remote directory browser', async () => {
    mocks.browseDir
      .mockResolvedValueOnce({
        resolvedPath: '/home/dev/ws',
        pathFlavor: 'posix',
        entries: [{ name: 'src', isDirectory: true }]
      })
      .mockResolvedValueOnce({
        resolvedPath: '/home/dev/ws/src',
        pathFlavor: 'posix',
        entries: []
      })
    useAppStore.setState({
      modalData: { repoId: 'repo-2' },
      repos: [
        { id: 'repo-2', path: '/home/dev/ws', displayName: 'ws', connectionId: 'tgt-9', executionHostId: null, kind: 'git' }
      ],
      settings: { codeIntelligenceScopes: [] },
      sshTargetLabels: new Map([['tgt-9', 'buildbox']])
    } as never)
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Add folder/ }))
    await waitFor(() => expect(mocks.browseDir).toHaveBeenCalledWith({ targetId: 'tgt-9', dirPath: '/home/dev/ws' }))
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })
})
